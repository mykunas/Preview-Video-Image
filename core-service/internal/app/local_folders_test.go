package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func waitLocalScan(t *testing.T, a *App) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		a.maintenanceMu.Lock()
		running := a.localFolderStatus["running"] == true
		failure := a.localFolderStatus["error"]
		a.maintenanceMu.Unlock()
		if !running {
			if failure != nil {
				t.Fatal(failure)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("scan did not complete")
}
func TestLocalFoldersManualSelection(t *testing.T) {
	ctx := context.Background()
	a, err := newConfiguredTestApp(ctx, Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	waitLocalScan(t, a)
	for _, rel := range []string{"大目录/电影/一/clip.mp4", "大目录/电影/二/clip.mp4", "大目录/照片/a/pic.JPG", "大目录/未选择/hidden.jpg", "大目录/电影/notes.txt"} {
		p := filepath.Join(a.downloadsDir, localFolderRoot, filepath.FromSlash(rel))
		if err = os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(p, []byte("sample"), 0444); err != nil {
			t.Fatal(err)
		}
		old := time.Now().Add(-2 * time.Minute)
		if err = os.Chtimes(p, old, old); err != nil {
			t.Fatal(err)
		}
	}
	outside := t.TempDir()
	os.WriteFile(filepath.Join(outside, "private.mp4"), []byte("private"), 0600)
	os.Symlink(outside, filepath.Join(a.downloadsDir, localFolderRoot, "大目录", "外部链接"))
	os.Symlink(filepath.Join(outside, "private.mp4"), filepath.Join(a.downloadsDir, localFolderRoot, "大目录", "电影", "link.mp4"))
	admin, err := a.sessions.Create(ctx, "admin")
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, url, body, session string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, url, strings.NewReader(body))
		if session != "" {
			req.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: session})
		}
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, req)
		return w
	}
	count := func(group string) int {
		var n int
		var e error
		if group == "" {
			e = a.db.Reader.QueryRowContext(ctx, "SELECT COUNT(*) FROM downloads WHERE group_id LIKE 'local:%'").Scan(&n)
		} else {
			e = a.db.Reader.QueryRowContext(ctx, "SELECT COUNT(*) FROM downloads WHERE group_id=?", group).Scan(&n)
		}
		if e != nil {
			t.Fatal(e)
		}
		return n
	}
	if _, _, err = a.indexLocalFolders(ctx); err != nil {
		t.Fatal(err)
	}
	if count("") != 0 {
		t.Fatal("unselected root auto-indexed")
	}
	browse := request("GET", "/api/library/folders/browse?path="+"大目录", "", admin)
	if browse.Code != 200 || strings.Contains(browse.Body.String(), "外部链接") {
		t.Fatal(browse.Code, browse.Body.String())
	}
	for _, p := range []string{"../", "/etc", "大目录/../照片", "大目录/外部链接"} {
		body, _ := json.Marshal(map[string]string{"path": p})
		w := request("POST", "/api/library/folders", string(body), admin)
		if w.Code != 400 {
			t.Fatal(p, w.Code, w.Body.String())
		}
	}
	if w := request("POST", "/api/library/folders", `{"path":"大目录"}`, admin); w.Code != 400 {
		t.Fatal("must choose a subfolder", w.Code)
	}
	for _, body := range []string{`{"path":"大目录/电影","name":"我的电影"}`, `{"path":"大目录/照片","name":"我的照片"}`} {
		w := request("POST", "/api/library/folders", body, admin)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		waitLocalScan(t, a)
	}
	if count("") != 3 || count(localFolderID("大目录/电影")) != 2 || count(localFolderID("大目录/照片")) != 1 {
		t.Fatal("subfolders were not isolated")
	}
	if w := request("POST", "/api/library/folders", `{"path":"大目录/电影/一"}`, admin); w.Code != 409 {
		t.Fatal("overlapping folders allowed", w.Code)
	}
	// Repeated scans retain row IDs and favorites; a rename changes display only.
	var originalID int64
	if err = a.db.Reader.QueryRowContext(ctx, "SELECT id FROM downloads WHERE group_id=? ORDER BY id LIMIT 1", localFolderID("大目录/电影")).Scan(&originalID); err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Writer.ExecContext(ctx, "UPDATE downloads SET pinned=1 WHERE id=?", originalID); err != nil {
		t.Fatal(err)
	}
	w := request("POST", "/api/library/folders", `{"path":"大目录/电影","name":"电影分类"}`, admin)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	waitLocalScan(t, a)
	var pinned int
	var name string
	if err = a.db.Reader.QueryRowContext(ctx, "SELECT pinned,group_name FROM downloads WHERE id=?", originalID).Scan(&pinned, &name); err != nil || pinned != 1 || name != "电影分类" {
		t.Fatal("rescan lost metadata", pinned, name, err)
	}
	selections, err := a.loadLocalFolderSelections()
	if err != nil || len(selections) != 2 {
		t.Fatal("selections not persisted", selections, err)
	}
	listing := request("GET", "/api/library/folders", "", admin)
	if listing.Code != 200 || !strings.Contains(listing.Body.String(), "电影分类") {
		t.Fatal(listing.Body.String())
	}
	// A source file removed externally is pruned on a complete scan.
	photo := filepath.Join(a.downloadsDir, localFolderRoot, "大目录", "照片", "a", "pic.JPG")
	if err = os.Remove(photo); err != nil {
		t.Fatal(err)
	}
	if _, _, err = a.indexLocalFolders(ctx); err != nil {
		t.Fatal(err)
	}
	if count(localFolderID("大目录/照片")) != 0 {
		t.Fatal("stale row retained")
	}
	if w = request("POST", "/api/library/folders/remove", `{"path":"大目录/电影"}`, admin); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	waitLocalScan(t, a)
	if count("") != 0 {
		t.Fatal("removed group still indexed")
	}
	b, err := os.ReadFile(filepath.Join(a.downloadsDir, localFolderRoot, "大目录", "电影", "一", "clip.mp4"))
	if err != nil || string(b) != "sample" {
		t.Fatal("source modified", err)
	}
	guest, err := a.sessions.Create(ctx, "guest")
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range []struct{ method, url string }{{"GET", "/api/library/folders"}, {"GET", "/api/library/folders/browse"}, {"POST", "/api/library/folders"}, {"POST", "/api/library/folders/remove"}, {"POST", "/api/library/folders/scan"}} {
		for _, session := range []string{guest, ""} {
			w := request(route.method, route.url, `{"path":"大目录/照片"}`, session)
			expected := 403
			if session == "" {
				expected = 401
			}
			if w.Code != expected {
				t.Fatal(route, w.Code, w.Body.String())
			}
		}
	}
}

func TestLocalFoldersLegacyIndexClearedWithoutDeletingSource(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	waitLocalScan(t, a)
	_, err = a.db.Writer.Exec(`INSERT INTO downloads(group_id,group_name,message_id,file_name,status) VALUES(?,'old',-1,'old.mp4','completed')`, localFolderID("旧的大目录"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = a.indexLocalFolders(context.Background()); err != nil {
		t.Fatal(err)
	}
	var n int
	if err = a.db.Reader.QueryRow("SELECT COUNT(*) FROM downloads WHERE group_id LIKE 'local:%'").Scan(&n); err != nil || n != 0 {
		t.Fatal(n, err)
	}
}
