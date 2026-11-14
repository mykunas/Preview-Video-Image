import { api } from './api.js';
import { escapeHtml, showToast } from './utils.js';
import { getMediaUrl, getThumbUrl } from './media-url.js';
import { SyncPlaybackController } from './sync-playback-controller.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';

const MAX_VIDEOS = 16;
let _controller = null;
let _selected = new Set();
let _source = null;
let _sourceId = null;
let _queueState = null;
let _layoutCleanup = null;

function _ensurePage() {
    let page = document.getElementById('page-multiview');
    if (page) return page;
    page = document.createElement('div');
    page.id = 'page-multiview';
    page.className = 'hidden max-w-7xl mx-auto px-3 sm:px-4 pb-24';
    document.getElementById('content-area')?.appendChild(page);
    return page;
}

function _formatTime(value) {
    if (!Number.isFinite(value) || value < 0) return '00:00';
    const total = Math.floor(value);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function _takeStoredSelection(source, id) {
    try {
        const raw = JSON.parse(sessionStorage.getItem('tgdl-multiview-selection') || 'null');
        sessionStorage.removeItem('tgdl-multiview-selection');
        if (
            raw &&
            raw.source === source &&
            String(raw.id) === String(id) &&
            Date.now() - Number(raw.at || 0) < 10 * 60_000
        ) {
            return raw;
        }
    } catch {}
    return null;
}

async function _loadSourceVideos(source, id) {
    if (source === 'collection') {
        const r = await api.get(
            `/api/favorite-collections/${encodeURIComponent(id)}/items?type=videos&limit=100`,
        );
        return { name: r.collection?.name || '', files: r.files || [], total: r.total || 0 };
    }
    if (source === 'channel') {
        const [r, groups] = await Promise.all([
            api.get(`/api/downloads/${encodeURIComponent(id)}?type=videos&limit=100&page=1`),
            api.get('/api/groups'),
        ]);
        const group = (groups || []).find((g) => String(g.id) === String(id));
        return { name: group?.name || String(id), files: r.files || [], total: r.total || 0 };
    }
    return { name: '', files: [], total: 0 };
}

async function _loadAllCollectionVideos(id) {
    const files = [];
    let page = 1;
    let total = 0;
    let name = '';
    do {
        const r = await api.get(
            `/api/favorite-collections/${encodeURIComponent(id)}/items?type=videos&limit=500&page=${page}`,
        );
        if (page === 1) {
            name = r.collection?.name || '';
            total = Number(r.total) || 0;
        }
        files.push(...(r.files || []));
        page += 1;
    } while (files.length < total);
    return { name, files, total };
}

async function _renderSourcePicker(page) {
    _setPlayerPageMode(page, false);
    const [collectionsResult, groups] = await Promise.all([
        api.get('/api/favorite-collections'),
        api.get('/api/groups'),
    ]);
    const collections = collectionsResult.collections || [];
    page.innerHTML = `
        <div class="mb-6">
            <h2 class="text-xl font-semibold text-tg-text">${escapeHtml(i18nT('multiview.title', 'Multi-view'))}</h2>
            <p class="text-sm text-tg-textSecondary mt-1">${escapeHtml(i18nT('multiview.choose_source', 'Choose a collection or channel, then select 2–6 videos.'))}</p>
        </div>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <section class="bg-tg-panel border border-tg-border/50 rounded-xl p-4">
                <h3 class="font-medium text-tg-text mb-3"><i class="ri-folder-star-line mr-2 text-yellow-400"></i>${escapeHtml(i18nT('collections.title', 'Collections'))}</h3>
                <div class="space-y-1 max-h-[60vh] overflow-y-auto">
                    ${collections
                        .map(
                            (c) => `<a href="#/multiview/collection/${encodeURIComponent(c.id)}" class="flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-tg-hover"><i class="${escapeHtml(c.icon)}" style="color:${escapeHtml(c.color)}"></i><span class="flex-1 text-tg-text truncate">${escapeHtml(c.name)}</span><span class="text-xs text-tg-textSecondary">${c.videoCount}</span><i class="ri-arrow-right-s-line text-tg-textSecondary"></i></a>`,
                        )
                        .join('')}
                </div>
            </section>
            <section class="bg-tg-panel border border-tg-border/50 rounded-xl p-4">
                <h3 class="font-medium text-tg-text mb-3"><i class="ri-chat-3-line mr-2 text-blue-400"></i>${escapeHtml(i18nT('multiview.channels', 'Channels and chats'))}</h3>
                <div class="space-y-1 max-h-[60vh] overflow-y-auto">
                    ${(groups || [])
                        .map(
                            (g) => `<a href="#/multiview/channel/${encodeURIComponent(g.id)}" class="flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-tg-hover"><i class="ri-movie-2-line text-tg-blue"></i><span class="flex-1 text-tg-text truncate">${escapeHtml(g.name)}</span><i class="ri-arrow-right-s-line text-tg-textSecondary"></i></a>`,
                        )
                        .join('')}
                </div>
            </section>
        </div>`;
}

function _pickerTile(file) {
    const thumb = getThumbUrl(file, 480);
    return `
        <button data-video-id="${file.id}" class="text-left rounded-xl overflow-hidden bg-tg-panel border border-tg-border/50 relative">
            <div class="aspect-video bg-black/40 relative">
                ${thumb ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" class="w-full h-full object-cover">` : '<div class="w-full h-full flex items-center justify-center text-4xl text-white/50"><i class="ri-film-line"></i></div>'}
                <span data-check class="absolute top-2 left-2 w-8 h-8 rounded-full bg-black/70 text-white flex items-center justify-center"><i class="ri-checkbox-blank-circle-line"></i></span>
                <i class="ri-play-circle-fill absolute inset-0 m-auto w-fit h-fit text-4xl text-white/80"></i>
            </div>
            <div class="p-3"><div class="text-sm text-tg-text truncate">${escapeHtml(file.name)}</div><div class="text-xs text-tg-textSecondary truncate mt-1">${escapeHtml(file.groupName || '')}</div></div>
        </button>`;
}

function _updatePicker(page) {
    page.querySelectorAll('[data-video-id]').forEach((tile) => {
        const on = _selected.has(Number(tile.dataset.videoId));
        tile.classList.toggle('ring-2', on);
        tile.classList.toggle('ring-tg-blue', on);
        const icon = tile.querySelector('[data-check] i');
        if (icon) icon.className = on ? 'ri-checkbox-circle-fill' : 'ri-checkbox-blank-circle-line';
    });
    const count = page.querySelector('[data-pick-count]');
    if (count) count.textContent = String(_selected.size);
    const start = page.querySelector('[data-start]');
    if (start) start.disabled = _selected.size < 1;
}

function _renderVideoPicker(page, sourceInfo) {
    _setPlayerPageMode(page, false);
    const files = sourceInfo.files || [];
    page.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div class="flex items-center gap-3 min-w-0">
                <a href="#/multiview" class="w-9 h-9 rounded-full hover:bg-tg-hover flex items-center justify-center"><i class="ri-arrow-left-line"></i></a>
                <div><h2 class="text-xl font-semibold text-tg-text truncate">${escapeHtml(sourceInfo.name)}</h2><p class="text-xs text-tg-textSecondary">${escapeHtml(i18nTf('multiview.video_total', { n: sourceInfo.total }, `${sourceInfo.total} videos`))}</p></div>
            </div>
            <button data-start disabled class="tg-btn px-4 py-2 disabled:opacity-40"><i class="ri-layout-grid-line mr-1"></i>${escapeHtml(i18nT('multiview.start', 'Start multi-view'))} (<span data-pick-count>0</span>)</button>
        </div>
        <div class="rounded-xl bg-tg-panel border border-tg-border/50 px-3 py-2 mb-4 text-xs text-tg-textSecondary">${escapeHtml(i18nTf('multiview.limit_help', { n: MAX_VIDEOS }, `Select 2–${MAX_VIDEOS} videos. Images are excluded.`))}</div>
        ${files.length ? `<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">${files.map(_pickerTile).join('')}</div>` : `<div class="text-center text-tg-textSecondary py-16"><i class="ri-film-line text-5xl block mb-3"></i>${escapeHtml(i18nT('multiview.no_videos', 'No videos found in this source.'))}</div>`}`;
    page.querySelectorAll('[data-video-id]').forEach((tile) => {
        tile.addEventListener('click', () => {
            const id = Number(tile.dataset.videoId);
            if (_selected.has(id)) _selected.delete(id);
            else if (_selected.size < MAX_VIDEOS) _selected.add(id);
            else showToast(i18nTf('multiview.max', { n: MAX_VIDEOS }, `Choose up to ${MAX_VIDEOS} videos`), 'info');
            _updatePicker(page);
        });
    });
    page.querySelector('[data-start]')?.addEventListener('click', () => {
        const picked = files.filter((file) => _selected.has(Number(file.id)));
        _renderPlayer(page, picked, sourceInfo.name);
    });
    _updatePicker(page);
}

function _concurrencyOptions(total, selected = 4) {
    const max = Math.min(MAX_VIDEOS, Math.max(1, total));
    return Array.from({ length: max }, (_, index) => index + 1)
        .map((n) => `<option value="${n}" ${n === Math.min(selected, max) ? 'selected' : ''}>${n}</option>`)
        .join('');
}

function _shuffleQueue(files) {
    const shuffled = [...files];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const replacement = Math.floor(Math.random() * (index + 1));
        [shuffled[index], shuffled[replacement]] = [shuffled[replacement], shuffled[index]];
    }
    return shuffled;
}

function _renderQueueSetup(page, sourceInfo) {
    _setPlayerPageMode(page, false);
    const total = sourceInfo.files?.length || 0;
    page.innerHTML = `
        <div class="flex items-center gap-3 mb-4">
            <a href="#/collections/${encodeURIComponent(_sourceId)}" class="w-9 h-9 rounded-full hover:bg-tg-hover flex items-center justify-center"><i class="ri-arrow-left-line"></i></a>
            <div><h2 class="text-xl font-semibold text-tg-text">${escapeHtml(sourceInfo.name)}</h2><p class="text-xs text-tg-textSecondary">${escapeHtml(i18nTf('multiview.queue_all', { n: total }, `Queue all ${total} videos`))}</p></div>
        </div>
        ${total >= 1 ? `<section class="max-w-xl bg-tg-panel border border-tg-border/50 rounded-xl p-5">
            <label class="block text-sm text-tg-text mb-2">${escapeHtml(i18nT('multiview.concurrent_count', 'Simultaneous videos'))}</label>
            <select data-concurrency class="w-full bg-tg-bg border border-tg-border rounded-lg px-3 py-3 text-tg-text mb-3">${_concurrencyOptions(total)}</select>
            <label class="flex items-center gap-2 text-sm text-tg-text mb-3 cursor-pointer select-none"><input data-random-queue type="checkbox" class="w-4 h-4 accent-tg-blue"><span><i class="ri-shuffle-line mr-1"></i>${escapeHtml(i18nT('multiview.random_play', 'Shuffle play'))}</span></label>
            <p class="text-xs text-tg-textSecondary mb-4">${escapeHtml(i18nT('multiview.queue_help', 'Every finished video is immediately replaced by the next one, while the other videos keep playing.'))}</p>
            <button data-start-queue class="tg-btn w-full px-4 py-3"><i class="ri-play-list-2-line mr-1"></i>${escapeHtml(i18nT('multiview.play_all', 'Play all videos'))}</button>
        </section>` : `<div class="text-center text-tg-textSecondary py-16"><i class="ri-film-line text-5xl block mb-3"></i>${escapeHtml(i18nT('multiview.no_videos', 'No videos found in this source.'))}</div>`}`;
    page.querySelector('[data-start-queue]')?.addEventListener('click', () => {
        const concurrency = Number(page.querySelector('[data-concurrency]')?.value) || 2;
        const randomize = !!page.querySelector('[data-random-queue]')?.checked;
        _startQueue(page, sourceInfo, concurrency, true, randomize);
    });
}

function _playerTile(file, index) {
    return `
        <article data-sync-tile data-sync-index="${index}" class="relative min-w-0 min-h-0 rounded-md overflow-hidden bg-black border border-white/10">
            <video data-sync-video playsinline preload="metadata" src="${escapeHtml(getMediaUrl(file))}" class="w-full h-full object-contain bg-black"></video>
            <button data-primary class="absolute inset-0 z-10" aria-label="${escapeHtml(i18nT('multiview.make_primary', 'Make primary video'))}"></button>
            <div class="absolute top-2 left-2 right-2 z-20 flex items-center justify-between pointer-events-none">
                <span data-video-name class="max-w-[80%] truncate text-xs text-white bg-black/65 rounded px-2 py-1">${escapeHtml(file.name)}</span>
                <span class="text-white bg-black/65 rounded-full w-7 h-7 flex items-center justify-center"><i data-audio-icon class="${index === 0 ? 'ri-volume-up-line' : 'ri-volume-mute-line'}"></i></span>
            </div>
            <div data-buffering class="hidden absolute inset-0 z-20 bg-black/40 items-center justify-center pointer-events-none"><i class="ri-loader-4-line animate-spin text-white text-3xl"></i></div>
        </article>`;
}

function _setPlayerPageMode(page, enabled) {
    if (!page) return;
    page.style.height = enabled ? '100%' : '';
    page.style.maxHeight = enabled ? '100%' : '';
    page.style.minHeight = enabled ? '0' : '';
    page.style.overflow = enabled ? 'hidden' : '';
    page.style.paddingBottom = enabled ? '0' : '';
    page.style.boxSizing = enabled ? 'border-box' : '';
    page.classList.toggle('flex', enabled);
    page.classList.toggle('flex-col', enabled);
}

function _fixedGrid(count) {
    const columns = count <= 1 ? 1 : count <= 4 ? 2 : count <= 9 ? 3 : 4;
    return { columns, rows: Math.ceil(count / columns) };
}

function _bestGrid(count, aspects, width, height) {
    const fallback = _fixedGrid(count);
    if (!width || !height || !count) return fallback;
    let best = { ...fallback, score: -Infinity };
    for (let columns = 1; columns <= count; columns++) {
        const rows = Math.ceil(count / columns);
        const tileWidth = width / columns;
        const tileHeight = height / rows;
        if (tileWidth < 72 || tileHeight < 56) continue;
        const tileAspect = tileWidth / tileHeight;
        const coverage = aspects.reduce((sum, aspect) => {
            const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
            return sum + Math.min(tileAspect / a, a / tileAspect);
        }, 0) / count;
        const emptyRatio = (rows * columns - count) / (rows * columns);
        const score = coverage - emptyRatio * 0.18;
        if (score > best.score) best = { columns, rows, score };
    }
    return best;
}

function _bindActivation(button, handler) {
    if (!button) return;
    button.addEventListener('click', handler);
}

function _installAutoLayout(grid, videos, button) {
    _layoutCleanup?.();
    let automatic = true;
    let frame = 0;
    const apply = () => {
        frame = 0;
        const rect = grid.getBoundingClientRect();
        const aspects = videos.map((video) =>
            video.videoWidth > 0 && video.videoHeight > 0
                ? video.videoWidth / video.videoHeight
                : 16 / 9,
        );
        const layout = automatic
            ? _bestGrid(videos.length, aspects, rect.width, rect.height)
            : _fixedGrid(videos.length);
        grid.style.gridTemplateColumns = `repeat(${layout.columns}, minmax(0, 1fr))`;
        grid.style.gridTemplateRows = `repeat(${layout.rows}, minmax(0, 1fr))`;
        grid.dataset.layout = `${layout.columns}x${layout.rows}`;
        if (button) {
            button.classList.toggle('bg-tg-blue', automatic);
            button.classList.toggle('text-white', automatic);
            button.title = automatic
                ? i18nT('multiview.auto_layout_on', 'Automatic layout is on')
                : i18nT('multiview.auto_layout_off', 'Fixed grid is on');
        }
    };
    const schedule = () => {
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(apply);
    };
    const onMetadata = () => schedule();
    videos.forEach((video) => video.addEventListener('loadedmetadata', onMetadata));
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    observer?.observe(grid);
    _bindActivation(button, () => {
        automatic = !automatic;
        apply();
    });
    schedule();
    _layoutCleanup = () => {
        if (frame) cancelAnimationFrame(frame);
        observer?.disconnect();
        videos.forEach((video) => video.removeEventListener('loadedmetadata', onMetadata));
        _layoutCleanup = null;
    };
}

function _renderPlayer(page, files, sourceName, queueMeta = null) {
    _destroyController();
    _setPlayerPageMode(page, true);
    const rollingQueueStatus = () => {
        const queue = _queueState;
        const total = queue?.files?.length || files.length;
        const nextIndex = queue?.nextIndex ?? files.length;
        return i18nTf(
            'multiview.queue_progress',
            {
                completed: queue?.completed || 0,
                total,
                playing: queue?.activeCount || 0,
                remaining: Math.max(0, total - nextIndex),
            },
            `${queue?.completed || 0}/${total} finished · ${queue?.activeCount || 0} playing · ${Math.max(0, total - nextIndex)} remaining`,
        );
    };
    const statusText = queueMeta?.rolling
        ? rollingQueueStatus()
        : queueMeta
        ? i18nTf(
              'multiview.batch_status',
              {
                  batch: queueMeta.batch,
                  batches: queueMeta.batches,
                  playing: files.length,
                  remaining: queueMeta.remaining,
              },
              `Batch ${queueMeta.batch}/${queueMeta.batches} · ${files.length} playing · ${queueMeta.remaining} remaining`,
          )
        : i18nTf('multiview.playing_n', { n: files.length }, `${files.length} videos playing together`);
    page.innerHTML = `
        <style>
            [data-player-shell]:fullscreen { width: 100vw; height: 100dvh; border-radius: 0; }
        </style>
        <div class="relative z-40 flex-none bg-tg-lightBg/95 flex flex-wrap items-center justify-between gap-2 py-1.5">
            <div class="flex items-center gap-3 min-w-0"><button data-back-picker class="w-9 h-9 rounded-full hover:bg-tg-hover flex items-center justify-center"><i class="ri-arrow-left-line"></i></button><div><h2 class="text-lg font-semibold text-tg-text truncate">${escapeHtml(sourceName)}</h2><p data-queue-status class="text-xs text-tg-textSecondary">${escapeHtml(statusText)}</p></div></div>
            <div class="flex items-center gap-1.5">${queueMeta?.hasNext ? `<button data-next-batch class="tg-btn-secondary px-2.5 py-2 text-sm"><i class="ri-skip-forward-line mr-1"></i>${escapeHtml(i18nT('multiview.next_batch', 'Next batch'))}</button>` : ''}<button data-auto-layout class="tg-btn-secondary px-2.5 py-2 text-sm"><i class="ri-layout-grid-line mr-1"></i><span class="hidden sm:inline">${escapeHtml(i18nT('multiview.auto_layout', 'Auto layout'))}</span></button><button data-fit-mode class="tg-btn-secondary px-2.5 py-2 text-sm" title="${escapeHtml(i18nT('multiview.fit_contain', 'Show full frame'))}"><i class="ri-aspect-ratio-line"></i></button><button data-fullscreen class="tg-btn-secondary px-2.5 py-2 text-sm"><i class="ri-fullscreen-line"></i><span class="hidden sm:inline ml-1">${escapeHtml(i18nT('viewer.video.fullscreen', 'Fullscreen'))}</span></button></div>
        </div>
        <div data-player-shell class="flex-1 min-h-0 flex flex-col bg-[#090909] rounded-xl overflow-hidden border border-white/10">
            <div data-video-grid class="flex-1 min-h-0 grid gap-1 p-1 overflow-hidden">
                ${files.map(_playerTile).join('')}
            </div>
            <div class="flex-none bg-[#171717]/95 text-white px-2 sm:px-3 py-2 flex flex-wrap items-center gap-2 sm:gap-3">
                <button data-play class="w-10 h-10 rounded-full bg-tg-blue flex items-center justify-center"><i class="ri-play-fill text-xl"></i></button>
                <button data-back class="w-9 h-9 rounded-full hover:bg-white/10"><i class="ri-replay-5-line"></i></button>
                <button data-forward class="w-9 h-9 rounded-full hover:bg-white/10"><i class="ri-forward-5-line"></i></button>
                <span data-time class="text-xs font-mono tabular-nums w-24 sm:w-28">00:00 / 00:00</span>
                <input data-progress type="range" min="0" max="0" step="0.05" value="0" class="order-last sm:order-none basis-full sm:basis-auto sm:flex-1 min-w-[160px] accent-blue-500">
                <button data-mute class="w-9 h-9 rounded-full hover:bg-white/10" title="${escapeHtml(i18nT('multiview.mute_all', 'Mute all'))}"><i class="ri-volume-up-line"></i></button>
                <select data-rate class="bg-white/10 rounded-lg px-2 py-2 text-sm text-white"><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select>
            </div>
        </div>`;

    const videos = Array.from(page.querySelectorAll('[data-sync-video]'));
    const grid = page.querySelector('[data-video-grid]');
    const progress = page.querySelector('[data-progress]');
    const time = page.querySelector('[data-time]');
    const play = page.querySelector('[data-play]');
    let allMuted = false;
    let fillMode = false;
    const finished = new Set();
    const slotBusy = new Set();
    let advancing = false;
    const refreshQueueStatus = () => {
        const status = page.querySelector('[data-queue-status]');
        if (status) status.textContent = rollingQueueStatus();
    };
    const markFinished = (index) => {
        if (queueMeta?.rolling) {
            if (slotBusy.has(index)) return;
            slotBusy.add(index);
            const queue = _queueState;
            if (!queue) return;
            queue.completed += 1;
            const next = queue.files[queue.nextIndex] || null;
            if (!next) {
                queue.activeCount = Math.max(0, queue.activeCount - 1);
                videos[index]?.closest('[data-sync-tile]')?.classList.add('opacity-50');
                refreshQueueStatus();
                if (queue.completed >= queue.files.length) {
                    const status = page.querySelector('[data-queue-status]');
                    if (status) status.textContent = i18nT('multiview.queue_complete', 'All videos finished');
                    showToast(i18nT('multiview.queue_complete', 'All videos finished'), 'success');
                }
                return;
            }
            queue.nextIndex += 1;
            const video = videos[index];
            const tile = video?.closest('[data-sync-tile]');
            tile?.classList.remove('opacity-50');
            const name = tile?.querySelector('[data-video-name]');
            if (name) name.textContent = next.name || '';
            if (video) {
                video.src = getMediaUrl(next);
                video.load();
                video.playbackRate = _controller?.baseRate || 1;
                const resume = () => {
                    slotBusy.delete(index);
                    video.play().catch(() => {});
                };
                video.addEventListener('canplay', resume, { once: true });
            }
            refreshQueueStatus();
            return;
        }
        if (!queueMeta || advancing) return;
        finished.add(index);
        if (finished.size < videos.length) return;
        advancing = true;
        if (queueMeta.hasNext) {
            setTimeout(() => _renderQueueBatch(page, queueMeta.batchIndex + 1, true), 150);
        } else {
            const status = page.querySelector('[data-queue-status]');
            if (status) status.textContent = i18nT('multiview.queue_complete', 'All videos finished');
            showToast(i18nT('multiview.queue_complete', 'All videos finished'), 'success');
        }
    };
    _controller = new SyncPlaybackController(videos, {
        synchronize: !queueMeta?.rolling,
        onState: (state) => {
            if (progress && !progress.matches(':active')) {
                progress.max = String(state.duration || 0);
                progress.value = String(Math.min(state.currentTime || 0, state.duration || 0));
            }
            if (time) time.textContent = `${_formatTime(state.currentTime)} / ${_formatTime(state.duration)}`;
            const icon = play?.querySelector('i');
            if (icon) icon.className = state.paused ? 'ri-play-fill text-xl' : 'ri-pause-fill text-xl';
            page.querySelectorAll('[data-audio-icon]').forEach((el, index) => {
                el.className = !allMuted && index === state.primaryIndex ? 'ri-volume-up-line' : 'ri-volume-mute-line';
            });
        },
    });
    videos.forEach((video, index) => {
        const tile = video.closest('[data-sync-tile]');
        tile?.querySelector('[data-primary]')?.addEventListener('click', () => {
            allMuted = false;
            _controller?.setPrimary(index);
        });
        video.addEventListener('waiting', () => {
            const el = tile?.querySelector('[data-buffering]');
            el?.classList.remove('hidden');
            el?.classList.add('flex');
        });
        const clearBuffer = () => {
            const el = tile?.querySelector('[data-buffering]');
            el?.classList.add('hidden');
            el?.classList.remove('flex');
        };
        video.addEventListener('playing', clearBuffer);
        video.addEventListener('canplay', clearBuffer);
        video.addEventListener('loadedmetadata', () => slotBusy.delete(index));
        video.addEventListener('ended', () => markFinished(index));
        video.addEventListener('error', () => {
            clearBuffer();
            tile?.classList.add('opacity-50');
            slotBusy.delete(index);
            markFinished(index);
        });
    });
    _installAutoLayout(grid, videos, page.querySelector('[data-auto-layout]'));
    _bindActivation(page.querySelector('[data-fit-mode]'), (event) => {
        fillMode = !fillMode;
        videos.forEach((video) => {
            video.classList.toggle('object-contain', !fillMode);
            video.classList.toggle('object-cover', fillMode);
        });
        event.currentTarget.classList.toggle('bg-tg-blue', fillMode);
        event.currentTarget.classList.toggle('text-white', fillMode);
        event.currentTarget.title = fillMode
            ? i18nT('multiview.fit_cover', 'Fill and crop')
            : i18nT('multiview.fit_contain', 'Show full frame');
    });
    play?.addEventListener('click', () => _controller?.toggle());
    page.querySelector('[data-back]')?.addEventListener('click', () => _controller?.seekRelative(-5));
    page.querySelector('[data-forward]')?.addEventListener('click', () => _controller?.seekRelative(5));
    progress?.addEventListener('input', () => _controller?.seek(Number(progress.value)));
    page.querySelector('[data-rate]')?.addEventListener('change', (e) => _controller?.setRate(e.target.value));
    page.querySelector('[data-mute]')?.addEventListener('click', (e) => {
        allMuted = !allMuted;
        if (allMuted) _controller?.setAllMuted(true);
        else _controller?.setPrimary(_controller.primaryIndex);
        const icon = e.currentTarget.querySelector('i');
        if (icon) icon.className = allMuted ? 'ri-volume-mute-line' : 'ri-volume-up-line';
    });
    _bindActivation(page.querySelector('[data-fullscreen]'), () => {
        page.querySelector('[data-player-shell]')?.requestFullscreen?.().catch(() => {});
    });
    _bindActivation(page.querySelector('[data-next-batch]'), () => {
        if (!queueMeta?.hasNext || advancing) return;
        advancing = true;
        _renderQueueBatch(page, queueMeta.batchIndex + 1, true);
    });
    page.querySelector('[data-back-picker]')?.addEventListener('click', async () => {
        destroy();
        if (_source === 'collection') {
            const info = await _loadAllCollectionVideos(_sourceId);
            _renderQueueSetup(page, info);
        } else {
            const info = await _loadSourceVideos(_source, _sourceId);
            _selected = new Set(files.map((f) => Number(f.id)));
            _renderVideoPicker(page, info);
        }
    });
    if (queueMeta?.autoplay) setTimeout(() => _controller?.play(), 0);
}

function _startQueue(page, sourceInfo, concurrency, autoplay = false, randomize = false) {
    const count = Math.max(1, Math.min(MAX_VIDEOS, Number(concurrency) || 1));
    const files = randomize ? _shuffleQueue(sourceInfo.files || []) : sourceInfo.files || [];
    _queueState = {
        files,
        name: sourceInfo.name,
        concurrency: count,
        randomize,
        nextIndex: Math.min(count, sourceInfo.files?.length || 0),
        completed: 0,
        activeCount: Math.min(count, sourceInfo.files?.length || 0),
    };
    const initial = _queueState.files.slice(0, _queueState.activeCount);
    if (!initial.length) return;
    _renderPlayer(page, initial, _queueState.name, { rolling: true, autoplay });
}

function _renderQueueBatch(page, batchIndex, autoplay = false) {
    if (!_queueState) return;
    const start = batchIndex * _queueState.concurrency;
    const batch = _queueState.files.slice(start, start + _queueState.concurrency);
    if (!batch.length) return;
    _queueState.batchIndex = batchIndex;
    const batches = Math.ceil(_queueState.files.length / _queueState.concurrency);
    const remaining = Math.max(0, _queueState.files.length - start - batch.length);
    _renderPlayer(page, batch, _queueState.name, {
        batchIndex,
        batch: batchIndex + 1,
        batches,
        remaining,
        hasNext: batchIndex + 1 < batches,
        autoplay,
    });
}

export async function showMultiViewPage({ source, sourceId } = {}) {
    const page = _ensurePage();
    destroy();
    _source = source || null;
    _sourceId = sourceId || null;
    page.innerHTML = `<div class="py-16 text-center text-tg-textSecondary"><i class="ri-loader-4-line animate-spin text-3xl"></i></div>`;
    try {
        if (!source || !sourceId) {
            await _renderSourcePicker(page);
            return;
        }
        const stored = _takeStoredSelection(source, sourceId);
        if (source === 'selection' && stored?.files?.length >= 1) {
            _selected = new Set(stored.ids.map(Number));
            _renderPlayer(page, stored.files.slice(0, MAX_VIDEOS), i18nT('multiview.selected_videos', 'Selected videos'));
            return;
        }
        if (source === 'collection') {
            const info = await _loadAllCollectionVideos(sourceId);
            if (stored?.mode === 'queue') {
                _startQueue(page, info, stored.concurrency, true, !!stored.randomize);
            } else {
                _renderQueueSetup(page, info);
            }
            return;
        }
        const info = await _loadSourceVideos(source, sourceId);
        _selected = new Set((stored?.ids || []).map(Number));
        const picked = info.files.filter((file) => _selected.has(Number(file.id))).slice(0, MAX_VIDEOS);
        if (picked.length >= 1) _renderPlayer(page, picked, info.name);
        else _renderVideoPicker(page, info);
    } catch (e) {
        page.innerHTML = `<div class="py-16 text-center text-red-300">${escapeHtml(e.message)}</div>`;
    }
}

export function destroy() {
    _queueState = null;
    _destroyController();
    _setPlayerPageMode(document.getElementById('page-multiview'), false);
}

function _destroyController() {
    _layoutCleanup?.();
    _controller?.destroy();
    _controller = null;
}
