import { api } from './api.js';
import { escapeHtml, showToast } from './utils.js';
import { getThumbUrl } from './media-url.js';
import { openSheet, promptSheet, confirmSheet } from './sheet.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';

const MAX_SYNC_VIDEOS = 16;
let _activeCollectionId = null;

function _ensurePage() {
    let page = document.getElementById('page-collections');
    if (page) return page;
    page = document.createElement('div');
    page.id = 'page-collections';
    page.className = 'hidden max-w-6xl mx-auto px-3 sm:px-4 pb-24';
    document.getElementById('content-area')?.appendChild(page);
    return page;
}

function _collectionCard(c) {
    return `
        <a href="#/collections/${encodeURIComponent(c.id)}"
           class="block bg-tg-panel border border-tg-border/50 rounded-xl p-4 hover:bg-tg-hover transition">
            <div class="flex items-start gap-3">
                <span class="w-11 h-11 rounded-xl flex items-center justify-center text-xl"
                      style="background:${escapeHtml(c.color)}22;color:${escapeHtml(c.color)}">
                    <i class="${escapeHtml(c.icon)}"></i>
                </span>
                <div class="min-w-0 flex-1">
                    <div class="font-medium text-tg-text truncate">${escapeHtml(c.name)}</div>
                    <div class="text-xs text-tg-textSecondary mt-1">${escapeHtml(
                        i18nTf(
                            'collections.counts',
                            { items: c.itemCount, videos: c.videoCount },
                            `${c.itemCount} items · ${c.videoCount} videos`,
                        ),
                    )}</div>
                </div>
                <i class="ri-arrow-right-s-line text-tg-textSecondary"></i>
            </div>
        </a>`;
}

async function _renderCollectionList(page) {
    const r = await api.get('/api/favorite-collections');
    const collections = r.collections || [];
    page.innerHTML = `
        <div class="flex items-center justify-between gap-3 mb-5">
            <div>
                <h2 class="text-xl font-semibold text-tg-text">${escapeHtml(i18nT('collections.title', 'Collections'))}</h2>
                <p class="text-sm text-tg-textSecondary mt-1">${escapeHtml(i18nT('collections.subtitle', 'Organise saved media into named folders.'))}</p>
            </div>
            <div class="flex items-center gap-2">
                <a href="#/multiview" class="tg-btn-secondary text-sm px-3 py-2">
                    <i class="ri-layout-grid-line mr-1"></i>${escapeHtml(i18nT('multiview.title', 'Multi-view'))}
                </a>
                <button data-new-collection class="tg-btn text-sm px-3 py-2">
                    <i class="ri-add-line mr-1"></i>${escapeHtml(i18nT('collections.new', 'New collection'))}
                </button>
            </div>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            ${collections.map(_collectionCard).join('')}
        </div>`;
    page.querySelector('[data-new-collection]')?.addEventListener('click', async () => {
        const name = await promptSheet({
            title: i18nT('collections.new', 'New collection'),
            message: i18nT('collections.name_help', 'Give this collection a short name.'),
            placeholder: i18nT('collections.name_placeholder', 'e.g. Travel'),
            confirmLabel: i18nT('common.create', 'Create'),
        });
        if (!name?.trim()) return;
        try {
            await api.post('/api/favorite-collections', { name: name.trim() });
            await _renderCollectionList(page);
        } catch (e) {
            showToast(e.message, 'error');
        }
    });
}

function _mediaTile(file) {
    const isVideo = file.type === 'videos';
    const thumb = getThumbUrl(file, 480);
    return `
        <article class="relative overflow-hidden rounded-xl bg-tg-panel border border-tg-border/50" data-collection-file="${escapeHtml(file.id)}" data-video="${isVideo ? '1' : '0'}">
            <div class="aspect-video bg-black/30 relative">
                ${
                    thumb
                        ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" class="w-full h-full object-cover">`
                        : `<div class="w-full h-full flex items-center justify-center text-3xl text-tg-textSecondary"><i class="${isVideo ? 'ri-film-line' : 'ri-file-line'}"></i></div>`
                }
                <button data-remove-item type="button" class="absolute top-2 right-2 z-10 w-7 h-7 rounded-full bg-black/70 text-white hover:bg-red-500 flex items-center justify-center" title="${escapeHtml(i18nT('collections.remove_item', 'Remove from collection'))}"><i class="ri-close-line"></i></button>
                ${isVideo ? '<i class="ri-play-circle-fill absolute inset-0 m-auto w-fit h-fit text-4xl text-white/80"></i>' : ''}
            </div>
            <div class="p-3">
                <div class="text-sm text-tg-text truncate" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
                <div class="text-xs text-tg-textSecondary truncate mt-1">${escapeHtml(file.groupName || '')}</div>
            </div>
        </article>`;
}

function _wireRemoveButtons(page) {
    page.querySelectorAll('[data-remove-item]').forEach((button) => {
        button.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const tile = button.closest('[data-collection-file]');
            const fileId = Number(tile?.dataset.collectionFile);
            if (!fileId) return;
            try {
                await api.delete(`/api/favorite-collections/${_activeCollectionId}/items`, {
                    downloadIds: [fileId],
                });
                showToast(i18nT('collections.removed_item', 'Removed from collection'), 'success');
                await _renderCollectionDetail(page, _activeCollectionId);
            } catch (e) {
                showToast(e.message, 'error');
            }
        });
    });
}

function _storeCollectionQueue(id, concurrency) {
    sessionStorage.setItem(
        'tgdl-multiview-selection',
        JSON.stringify({
            source: 'collection',
            id: String(id),
            mode: 'queue',
            concurrency,
            at: Date.now(),
        }),
    );
}

async function _renderCollectionDetail(page, id) {
    const r = await api.get(`/api/favorite-collections/${encodeURIComponent(id)}/items?limit=500`);
    const collection = r.collection;
    const files = r.files || [];
    const videos = files.filter((f) => f.type === 'videos');
    _activeCollectionId = Number(id);
    const defaultConcurrency = Math.min(MAX_SYNC_VIDEOS, Math.max(1, Math.min(4, videos.length)));
    const concurrencyOptions = Array.from(
        { length: Math.max(0, Math.min(MAX_SYNC_VIDEOS, videos.length)) },
        (_, index) => index + 1,
    )
        .map(
            (n) => `<option value="${n}" ${n === defaultConcurrency ? 'selected' : ''}>${n}</option>`,
        )
        .join('');
    page.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div class="flex items-center gap-3 min-w-0">
                <a href="#/collections" class="w-9 h-9 rounded-full hover:bg-tg-hover flex items-center justify-center"><i class="ri-arrow-left-line"></i></a>
                <span class="w-10 h-10 rounded-xl flex items-center justify-center" style="background:${escapeHtml(collection.color)}22;color:${escapeHtml(collection.color)}"><i class="${escapeHtml(collection.icon)}"></i></span>
                <div class="min-w-0">
                    <h2 class="text-xl font-semibold text-tg-text truncate">${escapeHtml(collection.name)}</h2>
                    <p class="text-xs text-tg-textSecondary">${escapeHtml(i18nTf('collections.counts', { items: r.total, videos: videos.length }, `${r.total} items · ${videos.length} videos`))}</p>
                </div>
            </div>
            <div class="flex items-center gap-2">
                <button data-rename class="tg-btn-secondary text-xs px-3 py-2"><i class="ri-edit-line mr-1"></i>${escapeHtml(i18nT('common.rename', 'Rename'))}</button>
                ${collection.isDefault ? '' : `<button data-delete class="tg-btn-secondary text-xs px-3 py-2 text-red-300"><i class="ri-delete-bin-line mr-1"></i>${escapeHtml(i18nT('common.delete', 'Delete'))}</button>`}
            </div>
        </div>
        <div class="sticky top-0 z-20 bg-tg-bg/95 backdrop-blur border border-tg-border/50 rounded-xl p-3 mb-4 flex flex-wrap items-center gap-2">
            <span class="text-sm text-tg-text">${escapeHtml(i18nTf('multiview.queue_all', { n: videos.length }, `Queue all ${videos.length} videos`))}</span>
            <span class="flex-1"></span>
            ${videos.length >= 1 ? `<label class="text-sm text-tg-textSecondary flex items-center gap-2">${escapeHtml(i18nT('multiview.concurrent_count', 'Screens'))}<select data-concurrency class="bg-tg-panel border border-tg-border rounded-lg px-2 py-2 text-tg-text">${concurrencyOptions}</select></label><button data-play-all class="tg-btn text-sm px-3 py-2"><i class="ri-layout-grid-line mr-1"></i>${escapeHtml(i18nT('multiview.play_all', 'Play all videos'))}</button>` : ''}
        </div>
        ${files.length ? `<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">${files.map(_mediaTile).join('')}</div>` : `<div class="text-center text-tg-textSecondary py-16"><i class="ri-folder-open-line text-5xl block mb-3"></i>${escapeHtml(i18nT('collections.empty', 'This collection is empty.'))}</div>`}`;

    page.querySelector('[data-play-all]')?.addEventListener('click', () => {
        const concurrency = Number(page.querySelector('[data-concurrency]')?.value) || defaultConcurrency;
        _storeCollectionQueue(id, concurrency);
        location.hash = `#/multiview/collection/${encodeURIComponent(id)}`;
    });
    page.querySelector('[data-rename]')?.addEventListener('click', async () => {
        const name = await promptSheet({
            title: i18nT('collections.rename', 'Rename collection'),
            defaultValue: collection.name,
            confirmLabel: i18nT('common.save', 'Save'),
        });
        if (!name?.trim()) return;
        await api.patch(`/api/favorite-collections/${collection.id}`, { name: name.trim() });
        await _renderCollectionDetail(page, id);
    });
    page.querySelector('[data-delete]')?.addEventListener('click', async () => {
        const ok = await confirmSheet({
            title: i18nT('collections.delete_title', 'Delete collection?'),
            message: i18nT('collections.delete_help', 'The downloaded files will not be deleted.'),
            confirmLabel: i18nT('common.delete', 'Delete'),
            danger: true,
        });
        if (!ok) return;
        await api.delete(`/api/favorite-collections/${collection.id}`);
        location.hash = '#/collections';
    });
    _wireRemoveButtons(page);
}

export async function showCollectionsPage({ collectionId } = {}) {
    const page = _ensurePage();
    page.innerHTML = `<div class="py-16 text-center text-tg-textSecondary"><i class="ri-loader-4-line animate-spin text-3xl"></i></div>`;
    try {
        if (collectionId) await _renderCollectionDetail(page, collectionId);
        else await _renderCollectionList(page);
    } catch (e) {
        page.innerHTML = `<div class="py-16 text-center text-red-300">${escapeHtml(e.message)}</div>`;
    }
}

export async function openAddToCollectionSheet(files) {
    const localFiles = (files || []).filter((f) => f?.id != null && (!f.peer_id || f.peer_id === 'self'));
    if (!localFiles.length) {
        showToast(i18nT('collections.local_only', 'Only local files can be added to collections.'), 'info');
        return false;
    }
    const r = await api.get('/api/favorite-collections');
    const renderButtons = (r.collections || [])
        .map(
            (c) => `<button data-collection-id="${c.id}" class="w-full flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-tg-hover text-left"><span class="w-9 h-9 rounded-lg flex items-center justify-center" style="background:${escapeHtml(c.color)}22;color:${escapeHtml(c.color)}"><i class="${escapeHtml(c.icon)}"></i></span><span class="flex-1 text-tg-text truncate">${escapeHtml(c.name)}</span><span class="text-xs text-tg-textSecondary">${c.itemCount}</span></button>`,
        )
        .join('');
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        const sheet = openSheet({
            title: i18nT('collections.add_to', 'Add to collection'),
            size: 'sm',
            content: `<div class="max-h-[55vh] overflow-y-auto space-y-1">${renderButtons}</div><button data-create-collection class="mt-3 w-full tg-btn-secondary text-sm py-2"><i class="ri-add-line mr-1"></i>${escapeHtml(i18nT('collections.new', 'New collection'))}</button>`,
            onClose: () => finish(false),
        });
        setTimeout(() => {
            const root = document.querySelector('.sheet-root:last-of-type');
            root?.querySelectorAll('[data-collection-id]').forEach((button) => {
                button.addEventListener('click', async () => {
                    try {
                        const result = await api.post(
                            `/api/favorite-collections/${button.dataset.collectionId}/items`,
                            { downloadIds: localFiles.map((f) => f.id) },
                        );
                        showToast(
                            i18nTf('collections.added', { count: result.count }, `Added ${result.count} item(s)`),
                            'success',
                        );
                        finish(true);
                        sheet.close();
                    } catch (e) {
                        showToast(e.message, 'error');
                    }
                });
            });
            root?.querySelector('[data-create-collection]')?.addEventListener('click', async () => {
                const name = await promptSheet({
                    title: i18nT('collections.new', 'New collection'),
                    placeholder: i18nT('collections.name_placeholder', 'e.g. Travel'),
                    confirmLabel: i18nT('common.create', 'Create'),
                });
                if (!name?.trim()) return;
                try {
                    const created = await api.post('/api/favorite-collections', { name: name.trim() });
                    const result = await api.post(
                        `/api/favorite-collections/${created.collection.id}/items`,
                        { downloadIds: localFiles.map((f) => f.id) },
                    );
                    showToast(i18nTf('collections.added', { count: result.count }, `Added ${result.count} item(s)`), 'success');
                    finish(true);
                    sheet.close();
                } catch (e) {
                    showToast(e.message, 'error');
                }
            });
        }, 60);
    });
}

export function getActiveCollectionId() {
    return _activeCollectionId;
}
