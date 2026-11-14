package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

const localFolderRoot = "_local"

type localFolderSelection struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

func registerLocalFolderRoutes(mux *http.ServeMux, a *App) {
	mux.Handle("POST /api/library/folders/auto-scan", a.requireAdmin(http.HandlerFunc(a.handleLocalFolderScanSettings)))
	mux.Handle("GET /api/library/folders", a.requireAdmin(http.HandlerFunc(a.handleLocalFolders)))
	mux.Handle("GET /api/library/folders/browse", a.requireAdmin(http.HandlerFunc(a.handleBrowseLocalFolders)))
	mux.Handle("POST /api/library/folders", a.requireAdmin(http.HandlerFunc(a.handleSelectLocalFolder)))
	mux.Handle("POST /api/library/folders/remove", a.requireAdmin(http.HandlerFunc(a.handleRemoveLocalFolder)))
	mux.Handle("POST /api/library/folders/scan", a.requireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.startLocalFolderScan() {
			writeJSONError(w, 409, "文件夹扫描已在运行，请稍后再试")
			return
		}
		writeJSON(w, 202, map[string]any{"started": true})
	})))
}
func localFolderID(name string) string {
	sum := sha256.Sum256([]byte(name))
	return "local:" + hex.EncodeToString(sum[:8])
}
func localFileID(rel string) int64 {
	sum := sha256.Sum256([]byte(rel))
	var id int64
	for _, b := range sum[:6] {
		id = id*256 + int64(b)
	}
	return -id - 1
}
func localMediaType(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".gif", ".bmp", ".avif":
		return "photo"
	case ".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".ts", ".mts", ".wmv":
		return "video"
	case ".mp3", ".ogg", ".wav", ".m4a", ".opus", ".flac", ".aac":
		return "audio"
	}
	return ""
}
func (a *App) loadLocalFolderSelections() ([]localFolderSelection, error) {
	folders := []localFolderSelection{}
	b, err := os.ReadFile(filepath.Join(a.dataDir, "selected-folders.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return folders, nil
	}
	if err != nil {
		return nil, err
	}
	err = json.Unmarshal(b, &folders)
	return folders, err
}

// Call with maintenanceMu held. Readers always see a complete settings file.
func (a *App) saveLocalFolderSelections(folders []localFolderSelection) error {
	b, err := json.MarshalIndent(folders, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(a.dataDir, ".selected-folders-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), filepath.Join(a.dataDir, "selected-folders.json"))
}
func validLocalFolderPath(p string) bool {
	if !fs.ValidPath(p) || p == "." || strings.ContainsAny(p, "\\\x00\r\n") {
		return false
	}
	for _, component := range strings.Split(p, "/") {
		if strings.HasPrefix(component, ".") {
			return false
		}
	}
	return true
}

// No links are followed; os.Root additionally confines opens during rename races.
func localFolderDirectory(root *os.Root, p string) error {
	if !validLocalFolderPath(p) {
		return fmt.Errorf("无效的文件夹路径")
	}
	current := ""
	for _, component := range strings.Split(p, "/") {
		current = path.Join(current, component)
		info, err := root.Lstat(current)
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("请选择实际目录，不支持符号链接")
		}
	}
	return nil
}
func (a *App) handleBrowseLocalFolders(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if p != "" && !validLocalFolderPath(p) {
		writeJSONError(w, 400, "无效的文件夹路径")
		return
	}
	root, err := os.OpenRoot(filepath.Join(a.downloadsDir, localFolderRoot))
	if errors.Is(err, fs.ErrNotExist) && p == "" {
		writeJSON(w, 200, map[string]any{"path": "", "directories": []any{}})
		return
	}
	if err != nil {
		writeJSONError(w, 400, "无法打开媒体目录")
		return
	}
	defer root.Close()
	if p != "" {
		if err = localFolderDirectory(root, p); err != nil {
			writeJSONError(w, 400, "目录不存在或无法访问")
			return
		}
	}
	dir := p
	if dir == "" {
		dir = "."
	}
	entries, err := fs.ReadDir(root.FS(), dir)
	if err != nil {
		writeJSONError(w, 400, "无法读取此目录")
		return
	}
	folders, err := a.loadLocalFolderSelections()
	if err != nil {
		writeJSONError(w, 500, "无法读取已添加的目录")
		return
	}
	directories := []map[string]any{}
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		rel := path.Join(p, entry.Name())
		selected := false
		for _, f := range folders {
			if f.Path == rel {
				selected = true
			}
		}
		directories = append(directories, map[string]any{"name": entry.Name(), "path": rel, "selected": selected})
	}
	writeJSON(w, 200, map[string]any{"path": p, "directories": directories})
}
func (a *App) handleSelectLocalFolder(w http.ResponseWriter, r *http.Request) {
	var folder localFolderSelection
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&folder) != nil || !validLocalFolderPath(folder.Path) || !strings.Contains(folder.Path, "/") {
		writeJSONError(w, 400, "请进入大目录，选择其中的子目录")
		return
	}
	folder.Name = strings.TrimSpace(folder.Name)
	if folder.Name == "" {
		folder.Name = path.Base(folder.Path)
	}
	if len([]rune(folder.Name)) > 80 || strings.ContainsAny(folder.Name, "\x00\r\n") {
		writeJSONError(w, 400, "名称最多 80 个字，不能换行")
		return
	}
	root, err := os.OpenRoot(filepath.Join(a.downloadsDir, localFolderRoot))
	if err != nil {
		writeJSONError(w, 400, "无法打开媒体目录")
		return
	}
	defer root.Close()
	if localFolderDirectory(root, folder.Path) != nil {
		writeJSONError(w, 400, "目录不存在或无法访问")
		return
	}
	a.maintenanceMu.Lock()
	if a.localFolderStatus["running"] == true {
		a.maintenanceMu.Unlock()
		writeJSONError(w, 409, "正在扫描，请完成后再添加目录")
		return
	}
	folders, err := a.loadLocalFolderSelections()
	found := false
	if err == nil {
		for i, existing := range folders {
			if existing.Path == folder.Path {
				folders[i] = folder
				found = true
				continue
			}
			if strings.HasPrefix(folder.Path, existing.Path+"/") || strings.HasPrefix(existing.Path, folder.Path+"/") {
				a.maintenanceMu.Unlock()
				writeJSONError(w, 409, "此目录与已添加的目录包含关系重叠，请分别选择同级目录")
				return
			}
		}
		if !found {
			folders = append(folders, folder)
		}
		err = a.saveLocalFolderSelections(folders)
	}
	a.maintenanceMu.Unlock()
	if err != nil {
		writeJSONError(w, 500, "无法保存目录设置")
		return
	}
	a.startLocalFolderScan()
	writeJSON(w, 200, map[string]any{"success": true})
}
func (a *App) handleRemoveLocalFolder(w http.ResponseWriter, r *http.Request) {
	var folder localFolderSelection
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&folder) != nil || !validLocalFolderPath(folder.Path) {
		writeJSONError(w, 400, "无效的文件夹路径")
		return
	}
	a.maintenanceMu.Lock()
	if a.localFolderStatus["running"] == true {
		a.maintenanceMu.Unlock()
		writeJSONError(w, 409, "正在扫描，请完成后再移除目录")
		return
	}
	folders, err := a.loadLocalFolderSelections()
	if err == nil {
		kept := []localFolderSelection{}
		for _, f := range folders {
			if f.Path != folder.Path {
				kept = append(kept, f)
			}
		}
		err = a.saveLocalFolderSelections(kept)
	}
	a.maintenanceMu.Unlock()
	if err != nil {
		writeJSONError(w, 500, "无法保存目录设置")
		return
	}
	a.startLocalFolderScan()
	writeJSON(w, 200, map[string]any{"success": true})
}
func (a *App) handleLocalFolders(w http.ResponseWriter, r *http.Request) {
	selections, err := a.loadLocalFolderSelections()
	if err != nil {
		writeJSONError(w, 500, "无法读取目录设置")
		return
	}
	folders := []map[string]any{}
	for _, folder := range selections {
		id := localFolderID(folder.Path)
		var count int64
		if err := a.db.Reader.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM downloads WHERE group_id=?", id).Scan(&count); err != nil {
			writeJSONError(w, 500, "无法读取索引")
			return
		}
		folders = append(folders, map[string]any{"name": folder.Name, "groupId": id, "path": path.Join(a.downloadsDir, localFolderRoot, folder.Path), "relativePath": folder.Path, "count": count})
	}
	a.maintenanceMu.Lock()
	status := cloneConfigValue(a.localFolderStatus)
	a.maintenanceMu.Unlock()
	if status == nil {
		status = map[string]any{"running": false, "indexed": 0, "errors": 0}
	}
	settings, settingsErr := a.loadLocalFolderScanSettings()
	a.maintenanceMu.Lock()
	nextScanAt := a.localFolderNextScanAt
	a.maintenanceMu.Unlock()
	auto := map[string]any{"enabled": settings.Enabled, "intervalMinutes": settings.IntervalMinutes, "settleSeconds": settings.SettleSeconds, "nextScanAt": nextScanAt}
	if settingsErr != nil {
		auto["enabled"] = false
		auto["error"] = "自动扫描设置无法读取，请重新保存"
	}
	writeJSON(w, 200, map[string]any{"folders": folders, "status": status, "autoScan": auto, "mountRoot": path.Join(a.downloadsDir, localFolderRoot)})
}
func (a *App) startLocalFolderScan() bool {
	a.maintenanceMu.Lock()
	if a.localFolderStatus["running"] == true {
		a.maintenanceMu.Unlock()
		return false
	}
	a.localFolderStatus = map[string]any{"running": true, "indexed": 0, "errors": 0, "startedAt": time.Now().UnixMilli()}
	a.maintenanceMu.Unlock()
	if !a.launchMaintenance(func() {
		indexed, failures, changed, err := a.indexLocalFoldersChanged(a.ctx)
		if err != nil {
			changed = 0
		}
		status := map[string]any{"running": false, "indexed": indexed, "errors": failures, "changed": changed, "finishedAt": time.Now().UnixMilli()}
		if err != nil {
			status["error"] = err.Error()
		}
		a.maintenanceMu.Lock()
		a.localFolderStatus = status
		a.maintenanceMu.Unlock()
		if err == nil && changed > 0 {
			a.broadcastStatsUpdate(a.ctx)
		}
		a.hub.Broadcast(ws.Event{Type: "reindex_done", Flat: true, Payload: map[string]any{"indexed": indexed, "errors": failures, "changed": changed, "kind": "localFolders"}})
	}) {
		a.maintenanceMu.Lock()
		a.localFolderStatus = map[string]any{"running": false, "error": "服务正在停止"}
		a.maintenanceMu.Unlock()
		return false
	}
	return true
}

// Scan only explicitly selected subdirectories. Never modify mounted media.
func (a *App) indexLocalFolders(ctx context.Context) (int, int, error) {
	indexed, failures, _, err := a.indexLocalFoldersChanged(ctx)
	return indexed, failures, err
}

func (a *App) indexLocalFoldersChanged(ctx context.Context) (int, int, int, error) {
	a.mediaMu.RLock()
	defer a.mediaMu.RUnlock()
	folders, err := a.loadLocalFolderSelections()
	if err != nil {
		return 0, 0, 0, err
	}
	settings, err := a.loadLocalFolderScanSettings()
	if err != nil {
		return 0, 0, 0, err
	}
	cutoff := time.Now().Add(-time.Duration(settings.SettleSeconds) * time.Second)
	root, err := os.OpenRoot(a.downloadsDir)
	if err != nil {
		return 0, 0, 0, err
	}
	defer root.Close()
	// Batch writes atomically instead of syncing the disk once per media file.
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, 0, err
	}
	defer tx.Rollback()
	ids, args := []string{}, []any{}
	for _, folder := range folders {
		if !validLocalFolderPath(folder.Path) || !strings.Contains(folder.Path, "/") {
			return 0, 0, 0, fmt.Errorf("目录设置包含无效路径")
		}
		ids = append(ids, "?")
		args = append(args, localFolderID(folder.Path))
	}
	query := "DELETE FROM downloads WHERE group_id LIKE 'local:%'"
	if len(ids) > 0 {
		query += " AND group_id NOT IN (" + strings.Join(ids, ",") + ")"
	}
	removed, err := tx.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, 0, 0, err
	}
	initialRemoved, _ := removed.RowsAffected()
	changed := int(initialRemoved)
	indexed, failures := 0, 0
	for _, folder := range folders {
		prefix := path.Join(localFolderRoot, folder.Path)
		if err = localFolderDirectory(root, prefix); err != nil {
			failures++
			continue
		}
		seen := map[int64]bool{}
		folderErrors := 0
		err = fs.WalkDir(root.FS(), prefix, func(rel string, entry fs.DirEntry, walkErr error) error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if walkErr != nil {
				folderErrors++
				return nil
			}
			if entry.IsDir() {
				if strings.HasPrefix(entry.Name(), ".") {
					return fs.SkipDir
				}
				return nil
			}
			if !entry.Type().IsRegular() || strings.HasPrefix(entry.Name(), ".") {
				return nil
			}
			kind := localMediaType(entry.Name())
			if kind == "" {
				return nil
			}
			file, openErr := root.Open(rel)
			if openErr != nil {
				folderErrors++
				return nil
			}
			info, statErr := file.Stat()
			file.Close()
			if statErr != nil {
				folderErrors++
				return nil
			}
			if !info.Mode().IsRegular() {
				return nil
			}
			id := localFileID(rel)
			// Keep existing rows while a downloader is modifying their source.
			seen[id] = true
			if info.Size() == 0 || (settings.SettleSeconds > 0 && info.ModTime().After(cutoff)) || localDownloadPending(root, rel) {
				return nil
			}
			result, sqlErr := tx.ExecContext(ctx, `INSERT INTO downloads(group_id,group_name,message_id,file_name,file_size,file_type,file_path,status) VALUES(?,?,?,?,?,?,?,'completed') ON CONFLICT(group_id,message_id) DO UPDATE SET group_name=excluded.group_name,file_name=excluded.file_name,file_size=excluded.file_size,file_type=excluded.file_type,file_path=excluded.file_path WHERE downloads.group_name IS NOT excluded.group_name OR downloads.file_name IS NOT excluded.file_name OR downloads.file_size IS NOT excluded.file_size OR downloads.file_type IS NOT excluded.file_type OR downloads.file_path IS NOT excluded.file_path`, localFolderID(folder.Path), folder.Name, id, entry.Name(), info.Size(), kind, filepath.ToSlash(rel))
			if sqlErr != nil {
				return sqlErr
			}
			seen[id] = true
			if affected, e := result.RowsAffected(); e == nil {
				changed += int(affected)
			}
			indexed++
			return nil
		})
		if err != nil {
			return indexed, failures + folderErrors, changed, err
		}
		failures += folderErrors
		// Avoid pruning on an incomplete scan or temporarily unavailable mount.
		if folderErrors == 0 {
			rows, queryErr := tx.QueryContext(ctx, "SELECT message_id FROM downloads WHERE group_id=?", localFolderID(folder.Path))
			if queryErr != nil {
				return indexed, failures, changed, queryErr
			}
			stale := []int64{}
			for rows.Next() {
				var id int64
				if err = rows.Scan(&id); err != nil {
					rows.Close()
					return indexed, failures, changed, err
				}
				if !seen[id] {
					stale = append(stale, id)
				}
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return indexed, failures, changed, err
			}
			for _, id := range stale {
				changed++
				if _, err = tx.ExecContext(ctx, "DELETE FROM downloads WHERE group_id=? AND message_id=?", localFolderID(folder.Path), id); err != nil {
					return indexed, failures, changed, err
				}
			}
		}
	}
	if err = tx.Commit(); err != nil {
		return indexed, failures, changed, err
	}
	return indexed, failures, changed, nil
}
