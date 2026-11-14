package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFavoriteCollectionsCRUDAndGallery(t *testing.T) {
	ctx := context.Background()
	a, err := newConfiguredTestApp(ctx, Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	token, err := a.sessions.Create(ctx, "admin")
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path, body string, status int) map[string]any {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body.String())
		}
		var out map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	for i, kind := range []string{"video", "photo", "video"} {
		_, err = a.db.Writer.ExecContext(ctx, "INSERT INTO downloads(id,group_id,message_id,file_name,file_type,file_path) VALUES(?, '-1001', ?, ?, ?, ?)", i+1, i+1, fmt.Sprintf("test%d.mp4", i), kind, fmt.Sprintf("media/test%d.mp4", i))
		if err != nil {
			t.Fatal(err)
		}
	}
	created := request("POST", "/api/favorite-collections", `{"name":"测试收藏","color":"#aabbcc"}`, 201)
	id := int64(created["collection"].(map[string]any)["id"].(float64))
	base := fmt.Sprintf("/api/favorite-collections/%d", id)
	added := request("POST", base+"/items", `{"downloadIds":[3,2,1,3,999999,-1]}`, 200)
	if added["count"] != float64(3) {
		t.Fatalf("unexpected additions: %v", added)
	}
	duplicate := request("POST", base+"/items", `{"downloadIds":[3]}`, 200)
	if duplicate["count"] != float64(0) {
		t.Fatal(duplicate)
	}
	page := request("GET", base+"/items?type=videos&limit=1&page=2&include=peers", "", 200)
	files := page["files"].([]any)
	if page["total"] != float64(2) || len(files) != 1 || files[0].(map[string]any)["id"] != float64(1) {
		t.Fatalf("pagination/type/order mismatch: %v", page)
	}
	if files[0].(map[string]any)["fullPath"] != "media/test0.mp4" {
		t.Fatal(files)
	}
	request("PATCH", base, `{"name":"重命名","icon":"ri-star-fill","sortOrder":2}`, 200)
	request("PATCH", base, `{"name":" "}`, 400)
	request("PATCH", base, `{"color":"red;background:url(x)"}`, 400)
	request("DELETE", base+"/items", `{"downloadIds":[2,999]}`, 200)
	request("DELETE", base, "", 200)
	request("GET", base+"/items", "", 404)
	var count int
	if err = a.db.Reader.QueryRowContext(ctx, "SELECT COUNT(*) FROM favorite_collection_items WHERE collection_id=?", id).Scan(&count); err != nil || count != 0 {
		t.Fatalf("cascade: %d %v", count, err)
	}
	list := request("GET", "/api/favorite-collections", "", 200)["collections"].([]any)
	defaultID := int64(list[0].(map[string]any)["id"].(float64))
	request("DELETE", fmt.Sprintf("/api/favorite-collections/%d", defaultID), "", 409)
	request("POST", "/api/downloads/1/pin", `{"pinned":true}`, 200)
	pinned := request("GET", fmt.Sprintf("/api/favorite-collections/%d/items", defaultID), "", 200)
	if pinned["total"] != float64(1) {
		t.Fatal(pinned)
	}
	request("POST", "/api/downloads/1/pin", `{"pinned":false}`, 200)
	unpinned := request("GET", fmt.Sprintf("/api/favorite-collections/%d/items", defaultID), "", 200)
	if unpinned["total"] != float64(0) {
		t.Fatal(unpinned)
	}
}

func TestFavoriteCollectionsRejectGuestAndAnonymous(t *testing.T) {
	ctx := context.Background()
	a, err := newConfiguredTestApp(ctx, Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	guest, err := a.sessions.Create(ctx, "guest")
	if err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{"", guest} {
		for _, method := range []string{"GET", "POST", "DELETE"} {
			path := "/api/favorite-collections"
			if method == "DELETE" {
				path += "/1"
			}
			r := httptest.NewRequest(method, path, strings.NewReader(`{"name":"forbidden"}`))
			if token != "" {
				r.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
			}
			w := httptest.NewRecorder()
			a.Handler().ServeHTTP(w, r)
			want := 401
			if token != "" {
				want = 403
			}
			if w.Code != want {
				t.Fatalf("%s token=%t: %d %s", method, token != "", w.Code, w.Body.String())
			}
		}
	}
}
