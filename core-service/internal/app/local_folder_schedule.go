package app

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

type localFolderScanSettings struct {
	Enabled         bool `json:"enabled"`
	IntervalMinutes int  `json:"intervalMinutes"`
	SettleSeconds   int  `json:"settleSeconds"`
}

func defaultLocalFolderScanSettings() localFolderScanSettings {
	return localFolderScanSettings{Enabled: true, IntervalMinutes: 5, SettleSeconds: 60}
}

func validLocalFolderScanSettings(s localFolderScanSettings) bool {
	return s.IntervalMinutes >= 1 && s.IntervalMinutes <= 1440 && s.SettleSeconds >= 0 && s.SettleSeconds <= 3600
}

func (a *App) loadLocalFolderScanSettings() (localFolderScanSettings, error) {
	s := defaultLocalFolderScanSettings()
	b, err := os.ReadFile(filepath.Join(a.dataDir, "local-folder-scan.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	if err = json.Unmarshal(b, &s); err != nil {
		return s, err
	}
	if !validLocalFolderScanSettings(s) {
		return s, errors.New("自动扫描设置无效，请重新保存")
	}
	return s, nil
}

func (a *App) saveLocalFolderScanSettings(s localFolderScanSettings) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(a.dataDir, ".local-folder-scan-*")
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
	return os.Rename(f.Name(), filepath.Join(a.dataDir, "local-folder-scan.json"))
}

func (a *App) handleLocalFolderScanSettings(w http.ResponseWriter, r *http.Request) {
	s := defaultLocalFolderScanSettings()
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048)).Decode(&s) != nil || !validLocalFolderScanSettings(s) {
		writeJSONError(w, 400, "扫描间隔应为 1–1440 分钟，文件稳定等待应为 0–3600 秒")
		return
	}
	a.maintenanceMu.Lock()
	err := a.saveLocalFolderScanSettings(s)
	if err == nil {
		a.localFolderNextScanAt = 0
	}
	a.maintenanceMu.Unlock()
	if err != nil {
		writeJSONError(w, 500, "无法保存自动扫描设置")
		return
	}
	select {
	case a.localFolderScheduleWake <- struct{}{}:
	default:
	}
	writeJSON(w, 200, map[string]any{"success": true, "autoScan": s})
}

// A completed scan and a due timer both use startLocalFolderScan's mutex gate.
// Settings changes reset the next run; disabling does not interrupt a live scan.
func (a *App) tickLocalFolderSchedule(now time.Time, s localFolderScanSettings) bool {
	a.maintenanceMu.Lock()
	if !s.Enabled {
		a.localFolderNextScanAt = 0
		a.maintenanceMu.Unlock()
		return false
	}
	due := a.localFolderNextScanAt > 0 && now.UnixMilli() >= a.localFolderNextScanAt
	if a.localFolderNextScanAt == 0 || due {
		a.localFolderNextScanAt = now.Add(time.Duration(s.IntervalMinutes) * time.Minute).UnixMilli()
	}
	a.maintenanceMu.Unlock()
	if due {
		return a.startLocalFolderScan()
	}
	return false
}

func (a *App) startLocalFolderScheduler() {
	a.localFolderScheduleWake = make(chan struct{}, 1)
	a.launchMaintenance(func() { a.runLocalFolderScheduler(a.ctx) })
}

func (a *App) runLocalFolderScheduler(ctx context.Context) {
	for ctx.Err() == nil {
		delay := time.Minute
		s, err := a.loadLocalFolderScanSettings()
		if err == nil {
			a.tickLocalFolderSchedule(time.Now(), s)
			a.maintenanceMu.Lock()
			next := a.localFolderNextScanAt
			a.maintenanceMu.Unlock()
			if s.Enabled {
				delay = time.Until(time.UnixMilli(next))
				if delay < 100*time.Millisecond {
					delay = 100 * time.Millisecond
				}
			} else {
				delay = 24 * time.Hour
			}
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-a.localFolderScheduleWake:
			timer.Stop()
		case <-timer.C:
		}
	}
}

func localDownloadPending(root *os.Root, rel string) bool {
	for _, suffix := range []string{".aria2", ".part", ".!qB", ".crdownload", ".download"} {
		if _, err := root.Lstat(rel + suffix); err == nil {
			return true
		}
	}
	return false
}
