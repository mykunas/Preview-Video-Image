package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLocalFolderScanSettingsAndAuthorization(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	waitLocalScan(t, a)
	s, err := a.loadLocalFolderScanSettings()
	if err != nil || !s.Enabled || s.IntervalMinutes != 5 || s.SettleSeconds != 60 {
		t.Fatal(s, err)
	}
	admin, _ := a.sessions.Create(context.Background(), "admin")
	guest, _ := a.sessions.Create(context.Background(), "guest")
	req := func(body, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/api/library/folders/auto-scan", strings.NewReader(body))
		if token != "" {
			r.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
		}
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		return w
	}
	for _, body := range []string{`{"intervalMinutes":0}`, `{"intervalMinutes":1441}`, `{"settleSeconds":-1}`, `{"settleSeconds":3601}`, `{"intervalMinutes":1.5}`, `{"enabled":"yes"}`} {
		if w := req(body, admin); w.Code != 400 {
			t.Fatal(body, w.Code, w.Body.String())
		}
	}
	if w := req(`{"enabled":false,"intervalMinutes":10,"settleSeconds":120}`, admin); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	s, err = a.loadLocalFolderScanSettings()
	if err != nil || s.Enabled || s.IntervalMinutes != 10 || s.SettleSeconds != 120 {
		t.Fatal("settings not persisted", s, err)
	}
	for _, token := range []string{guest, ""} {
		w := req(`{"enabled":true}`, token)
		expected := 403
		if token == "" {
			expected = 401
		}
		if w.Code != expected {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}

func TestLocalFolderScheduleDueAndNoOverlap(t *testing.T) {
	a := &App{ctx: context.Background(), localFolderStatus: map[string]any{"running": true}}
	now := time.Unix(1700000000, 0)
	s := localFolderScanSettings{Enabled: true, IntervalMinutes: 5, SettleSeconds: 60}
	if a.tickLocalFolderSchedule(now, s) {
		t.Fatal("initialization started a scan")
	}
	if got := a.localFolderNextScanAt; got != now.Add(5*time.Minute).UnixMilli() {
		t.Fatal(got)
	}
	if a.tickLocalFolderSchedule(now.Add(4*time.Minute), s) {
		t.Fatal("early scan")
	}
	if a.tickLocalFolderSchedule(now.Add(5*time.Minute), s) {
		t.Fatal("overlapping scan")
	}
	if got := a.localFolderNextScanAt; got != now.Add(10*time.Minute).UnixMilli() {
		t.Fatal("next run was not advanced", got)
	}
	s.Enabled = false
	a.tickLocalFolderSchedule(now.Add(6*time.Minute), s)
	if a.localFolderNextScanAt != 0 {
		t.Fatal("disabled schedule has a next run")
	}
}

func TestLocalFolderSettlingMarkersAndIncrementalWrites(t *testing.T) {
	ctx := context.Background()
	a, err := newConfiguredTestApp(ctx, Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	waitLocalScan(t, a)
	base := filepath.Join(a.downloadsDir, localFolderRoot, "媒体", "分类")
	if err = os.MkdirAll(base, 0755); err != nil {
		t.Fatal(err)
	}
	write := func(name string, stable bool) {
		t.Helper()
		p := filepath.Join(base, name)
		if err := os.WriteFile(p, []byte("sample content"), 0644); err != nil {
			t.Fatal(err)
		}
		if stable {
			old := time.Now().Add(-2 * time.Minute)
			if err := os.Chtimes(p, old, old); err != nil {
				t.Fatal(err)
			}
		}
	}
	write("stable.jpg", true)
	write("fresh.jpg", false)
	write("blocked.jpg", true)
	write("blocked.jpg.aria2", true)
	write("unfinished.mp4.part", true)
	write(".hidden.jpg", true)
	a.maintenanceMu.Lock()
	err = a.saveLocalFolderSelections([]localFolderSelection{{Path: "媒体/分类", Name: "分类"}})
	a.maintenanceMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	n, failures, changed, err := a.indexLocalFoldersChanged(ctx)
	if err != nil || n != 1 || failures != 0 || changed != 1 {
		t.Fatal(n, failures, changed, err)
	}
	n, failures, changed, err = a.indexLocalFoldersChanged(ctx)
	if err != nil || n != 1 || changed != 0 {
		t.Fatal("unchanged scan rewrote data", n, failures, changed, err)
	}
	// A previously indexed source being rewritten must not be pruned.
	if err = os.Chtimes(filepath.Join(base, "stable.jpg"), time.Now(), time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err = a.indexLocalFoldersChanged(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = a.db.Reader.QueryRow("SELECT COUNT(*) FROM downloads WHERE group_id=?", localFolderID("媒体/分类")).Scan(&count); err != nil || count != 1 {
		t.Fatal("deferred row removed", count, err)
	}
	old := time.Now().Add(-2 * time.Minute)
	if err = os.Chtimes(filepath.Join(base, "fresh.jpg"), old, old); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(filepath.Join(base, "blocked.jpg.aria2")); err != nil {
		t.Fatal(err)
	}
	n, failures, changed, err = a.indexLocalFoldersChanged(ctx)
	if err != nil || n != 2 || failures != 0 || changed != 2 {
		t.Fatal("completed files not synchronized", n, failures, changed, err)
	}
	if err = a.db.Reader.QueryRow("SELECT COUNT(*) FROM downloads WHERE group_id=?", localFolderID("媒体/分类")).Scan(&count); err != nil || count != 3 {
		t.Fatal(count, err)
	}
	if err = os.Remove(filepath.Join(base, "fresh.jpg")); err != nil {
		t.Fatal(err)
	}
	_, _, changed, err = a.indexLocalFoldersChanged(ctx)
	if err != nil || changed != 1 {
		t.Fatal("stale row not pruned", changed, err)
	}
}
