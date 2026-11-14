package app

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

// This is an additive migration: the native media catalog remains authoritative.
func (a *App) initializeFavorites(ctx context.Context) error {
	_, err := a.db.Writer.ExecContext(ctx, `
 CREATE TABLE IF NOT EXISTS favorite_collections (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT, icon TEXT,
 sort_order INTEGER NOT NULL DEFAULT 0, is_default INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS idx_favorite_collections_default ON favorite_collections(is_default) WHERE is_default=1;
 CREATE TABLE IF NOT EXISTS favorite_collection_items (
 collection_id INTEGER NOT NULL REFERENCES favorite_collections(id) ON DELETE CASCADE,
 download_id INTEGER NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
 position INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL,
 PRIMARY KEY(collection_id,download_id));
 CREATE INDEX IF NOT EXISTS idx_favorite_items_download ON favorite_collection_items(download_id);
 CREATE INDEX IF NOT EXISTS idx_favorite_items_position ON favorite_collection_items(collection_id,position);
 INSERT INTO favorite_collections(name,color,icon,is_default,created_at,updated_at)
 SELECT '收藏夹','#f59e0b','ri-star-fill',1,?,? WHERE NOT EXISTS (SELECT 1 FROM favorite_collections WHERE is_default=1);
 INSERT OR IGNORE INTO favorite_collection_items(collection_id,download_id,position,added_at)
 SELECT c.id,d.id,d.id,? FROM favorite_collections c JOIN downloads d ON d.pinned=1 WHERE c.is_default=1;
 CREATE TRIGGER IF NOT EXISTS tgdl_favorites_pin_update AFTER UPDATE OF pinned ON downloads BEGIN
 INSERT OR IGNORE INTO favorite_collection_items(collection_id,download_id,position,added_at)
 SELECT c.id,NEW.id,COALESCE((SELECT MAX(position)+1 FROM favorite_collection_items WHERE collection_id=c.id),1),CAST(strftime('%s','now') AS INTEGER)*1000
 FROM favorite_collections c WHERE c.is_default=1 AND NEW.pinned=1;
 DELETE FROM favorite_collection_items WHERE download_id=NEW.id AND collection_id IN (SELECT id FROM favorite_collections WHERE is_default=1) AND NEW.pinned=0;
 END;`, time.Now().UnixMilli(), time.Now().UnixMilli(), time.Now().UnixMilli())
	return err
}

func registerFavoriteRoutes(mux *http.ServeMux, a *App) {
	for _, route := range []string{"GET /api/favorite-collections", "POST /api/favorite-collections", "PATCH /api/favorite-collections/{id}", "DELETE /api/favorite-collections/{id}", "GET /api/favorite-collections/{id}/items", "POST /api/favorite-collections/{id}/items", "DELETE /api/favorite-collections/{id}/items"} {
		mux.Handle(route, a.requireAdmin(http.HandlerFunc(a.handleFavoriteCollections)))
	}
}

const favoriteSelect = `SELECT c.id,c.name,COALESCE(c.color,'#f59e0b'),COALESCE(c.icon,'ri-folder-star-line'),c.sort_order,c.is_default,c.created_at,c.updated_at,COUNT(d.id),COALESCE(SUM(CASE WHEN d.file_type='video' THEN 1 ELSE 0 END),0) FROM favorite_collections c LEFT JOIN favorite_collection_items i ON i.collection_id=c.id LEFT JOIN downloads d ON d.id=i.download_id`

type favoriteScanner interface{ Scan(...any) error }

func scanFavorite(row favoriteScanner) (map[string]any, error) {
	var id, order, def, created, updated, count, videos int64
	var name, color, icon string
	err := row.Scan(&id, &name, &color, &icon, &order, &def, &created, &updated, &count, &videos)
	return map[string]any{"id": id, "name": name, "color": color, "icon": icon, "sortOrder": order, "isDefault": def == 1, "createdAt": created, "updatedAt": updated, "itemCount": count, "videoCount": videos}, err
}
func (a *App) favorite(ctx context.Context, id int64) (map[string]any, error) {
	return scanFavorite(a.db.Reader.QueryRowContext(ctx, favoriteSelect+" WHERE c.id=? GROUP BY c.id", id))
}

var favoriteColor = regexp.MustCompile(`^#[a-fA-F0-9]{6}$`)
var favoriteIcon = regexp.MustCompile(`^ri-[a-zA-Z0-9-]{1,48}$`)

func cleanFavoriteName(v string) string {
	v = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.TrimSpace(v))
	r := []rune(v)
	if len(r) > 80 {
		r = r[:80]
	}
	return string(r)
}
func (a *App) favoriteChanged(action string, id int64) {
	a.hub.Broadcast(ws.Event{Type: "favorite_collection_changed", Flat: true, Roles: []string{"admin"}, Payload: map[string]any{"action": action, "id": id}})
}
func (a *App) handleFavoriteCollections(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rawID := r.PathValue("id")
	id, _ := strconv.ParseInt(rawID, 10, 64)
	fail := func() { writeJSONError(w, 500, "Collection database operation failed") }
	if rawID == "" && r.Method == "GET" {
		rows, err := a.db.Reader.QueryContext(ctx, favoriteSelect+" GROUP BY c.id ORDER BY c.sort_order,c.id")
		if err != nil {
			fail()
			return
		}
		defer rows.Close()
		items := []map[string]any{}
		for rows.Next() {
			item, err := scanFavorite(rows)
			if err != nil {
				fail()
				return
			}
			items = append(items, item)
		}
		if rows.Err() != nil {
			fail()
			return
		}
		writeJSON(w, 200, map[string]any{"collections": items})
		return
	}
	var current map[string]any
	if rawID != "" {
		if id <= 0 {
			writeJSONError(w, 400, "Invalid collection id")
			return
		}
		var err error
		current, err = a.favorite(ctx, id)
		if errors.Is(err, sql.ErrNoRows) {
			writeJSONError(w, 404, "Collection not found")
			return
		}
		if err != nil {
			fail()
			return
		}
	}
	isItems := strings.HasSuffix(r.URL.Path, "/items")
	if isItems && r.Method == "GET" {
		page, limit := galleryPageLimit(r.URL.Query(), 500, false)
		files, total, err := a.queryGalleryFiles(r, galleryQuery{collectionID: id, typeName: r.URL.Query().Get("type"), limit: limit, offset: (page - 1) * limit})
		if err != nil {
			fail()
			return
		}
		writeJSON(w, 200, map[string]any{"collection": current, "files": files, "total": total, "page": page, "totalPages": pages(total, limit)})
		return
	}
	if isItems {
		var body struct {
			DownloadIDs []int64 `json:"downloadIds"`
		}
		if decodeBody(w, r, &body) != nil {
			return
		}
		if len(body.DownloadIDs) == 0 || len(body.DownloadIDs) > 5000 {
			writeJSONError(w, 400, "downloadIds must contain 1–5000 ids")
			return
		}
		tx, err := a.db.Writer.BeginTx(ctx, nil)
		if err != nil {
			fail()
			return
		}
		defer tx.Rollback()
		// Check again inside the write transaction: collection deletion must not race an add.
		var exists int
		if err = tx.QueryRowContext(ctx, "SELECT 1 FROM favorite_collections WHERE id=?", id).Scan(&exists); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				writeJSONError(w, 404, "Collection not found")
			} else {
				fail()
			}
			return
		}
		var position int64
		if err = tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(position),0)+1 FROM favorite_collection_items WHERE collection_id=?", id).Scan(&position); err != nil {
			fail()
			return
		}
		changed := []int64{}
		seen := map[int64]bool{}
		for _, downloadID := range body.DownloadIDs {
			if downloadID <= 0 || seen[downloadID] {
				continue
			}
			seen[downloadID] = true
			var result sql.Result
			if r.Method == "POST" {
				result, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO favorite_collection_items(collection_id,download_id,position,added_at) SELECT ?,id,?,? FROM downloads WHERE id=?", id, position, time.Now().UnixMilli(), downloadID)
				position++
			} else {
				result, err = tx.ExecContext(ctx, "DELETE FROM favorite_collection_items WHERE collection_id=? AND download_id=?", id, downloadID)
			}
			if err != nil {
				fail()
				return
			}
			n, err := result.RowsAffected()
			if err != nil {
				fail()
				return
			}
			if n > 0 {
				changed = append(changed, downloadID)
			}
		}
		if err = tx.Commit(); err != nil {
			fail()
			return
		}
		key, action := "added", "items_added"
		if r.Method == "DELETE" {
			key, action = "removed", "items_removed"
		}
		a.favoriteChanged(action, id)
		writeJSON(w, 200, map[string]any{"success": true, key: changed, "count": len(changed)})
		return
	}
	if r.Method == "DELETE" {
		if current["isDefault"] == true {
			writeJSONError(w, 409, "The default collection cannot be deleted")
			return
		}
		if _, err := a.db.Writer.ExecContext(ctx, "DELETE FROM favorite_collections WHERE id=? AND is_default=0", id); err != nil {
			fail()
			return
		}
		a.favoriteChanged("deleted", id)
		writeJSON(w, 200, map[string]any{"success": true})
		return
	}
	var body map[string]any
	if decodeBody(w, r, &body) != nil {
		return
	}
	name, color, icon := "", "#f59e0b", "ri-folder-star-line"
	order := int64(0)
	if current != nil {
		name = current["name"].(string)
		color = current["color"].(string)
		icon = current["icon"].(string)
		order = current["sortOrder"].(int64)
	}
	if value, ok := body["name"]; ok {
		name = cleanFavoriteName(toString(value))
	}
	if name == "" {
		writeJSONError(w, 400, "Collection name required")
		return
	}
	if value, ok := body["color"]; ok {
		color = toString(value)
		if !favoriteColor.MatchString(color) {
			writeJSONError(w, 400, "Invalid color")
			return
		}
	}
	if value, ok := body["icon"]; ok {
		icon = toString(value)
		if !favoriteIcon.MatchString(icon) {
			writeJSONError(w, 400, "Invalid icon")
			return
		}
	}
	if value, ok := body["sortOrder"].(float64); ok {
		if value > 1000000 || value < -1000000 {
			writeJSONError(w, 400, "Invalid sort order")
			return
		}
		order = int64(value)
	}
	now := time.Now().UnixMilli()
	status, action := 200, "updated"
	if rawID == "" {
		result, err := a.db.Writer.ExecContext(ctx, "INSERT INTO favorite_collections(name,color,icon,sort_order,is_default,created_at,updated_at) VALUES(?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM favorite_collections),0,?,?)", name, color, icon, now, now)
		if err != nil {
			fail()
			return
		}
		id, err = result.LastInsertId()
		if err != nil {
			fail()
			return
		}
		status, action = 201, "created"
	} else {
		if _, err := a.db.Writer.ExecContext(ctx, "UPDATE favorite_collections SET name=?,color=?,icon=?,sort_order=?,updated_at=? WHERE id=?", name, color, icon, order, now, id); err != nil {
			fail()
			return
		}
	}
	item, err := a.favorite(ctx, id)
	if err != nil {
		fail()
		return
	}
	a.favoriteChanged(action, id)
	writeJSON(w, status, map[string]any{"collection": item})
}
