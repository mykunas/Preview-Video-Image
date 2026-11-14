// Multi-video synchronisation controller. The normal viewer owns one fixed
// #modal-video element; this controller intentionally accepts arbitrary video
// elements so the multi-view page can run several independent decoders.

export class SyncPlaybackController {
    constructor(videos, opts = {}) {
        this.videos = Array.from(videos || []).filter(Boolean);
        this.primaryIndex = 0;
        this.baseRate = 1;
        this.syncIntervalMs = Math.max(100, Number(opts.syncIntervalMs) || 250);
        this.softDrift = Number(opts.softDrift) || 0.08;
        this.hardDrift = Number(opts.hardDrift) || 0.25;
        // A collection queue is intentionally independent: a replacement
        // video starts from 00:00 instead of being aligned to another tile.
        this.synchronize = opts.synchronize !== false;
        this.onState = typeof opts.onState === 'function' ? opts.onState : () => {};
        this._timer = null;
        this._destroyed = false;
        this._wire();
        this.setPrimary(0);
    }

    _wire() {
        this._onTime = () => this._emit();
        this._onMediaState = () => this._emit();
        for (const video of this.videos) {
            video.addEventListener('timeupdate', this._onTime);
            video.addEventListener('durationchange', this._onMediaState);
            video.addEventListener('play', this._onMediaState);
            video.addEventListener('pause', this._onMediaState);
            video.addEventListener('ended', this._onMediaState);
        }
    }

    get primary() {
        return this.videos[this.primaryIndex] || this.videos[0] || null;
    }

    get duration() {
        return this.videos.reduce(
            (max, video) => (Number.isFinite(video.duration) ? Math.max(max, video.duration) : max),
            0,
        );
    }

    get currentTime() {
        return Number(this.primary?.currentTime) || 0;
    }

    get paused() {
        return this.videos.every((video) => video.paused || video.ended);
    }

    setPrimary(index) {
        const next = Math.max(0, Math.min(this.videos.length - 1, Number(index) || 0));
        this.primaryIndex = next;
        this.videos.forEach((video, i) => {
            video.muted = i !== next;
            video.closest('[data-sync-tile]')?.classList.toggle('ring-2', i === next);
            video.closest('[data-sync-tile]')?.classList.toggle('ring-tg-blue', i === next);
        });
        this._emit();
    }

    async play() {
        if (this._destroyed) return;
        const target = this.currentTime;
        for (const video of this.videos) {
            if (this.synchronize && Number.isFinite(video.duration) && target < video.duration - 0.05) {
                if (Math.abs(video.currentTime - target) > this.hardDrift) video.currentTime = target;
            }
            video.playbackRate = this.baseRate;
        }
        await Promise.allSettled(
            this.videos.map((video) => {
                if (video.ended || (Number.isFinite(video.duration) && target >= video.duration)) {
                    return Promise.resolve();
                }
                return video.play();
            }),
        );
        if (this.synchronize) this._startSync();
        this._emit();
    }

    pause() {
        for (const video of this.videos) video.pause();
        this._stopSync();
        this._emit();
    }

    toggle() {
        return this.paused ? this.play() : this.pause();
    }

    seek(time) {
        const next = Math.max(0, Number(time) || 0);
        for (const video of this.videos) {
            if (!Number.isFinite(video.duration)) continue;
            video.currentTime = Math.min(next, Math.max(0, video.duration - 0.01));
        }
        this._emit();
    }

    seekRelative(delta) {
        this.seek(this.currentTime + Number(delta || 0));
    }

    setRate(rate) {
        this.baseRate = Math.max(0.25, Math.min(2, Number(rate) || 1));
        for (const video of this.videos) video.playbackRate = this.baseRate;
        this._emit();
    }

    setAllMuted(muted) {
        for (const video of this.videos) video.muted = !!muted;
        this._emit();
    }

    _startSync() {
        if (!this.synchronize) return;
        if (this._timer) return;
        this._timer = setInterval(() => this._correctDrift(), this.syncIntervalMs);
    }

    _stopSync() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
        for (const video of this.videos) video.playbackRate = this.baseRate;
    }

    _correctDrift() {
        let primary = this.primary;
        if (!primary || primary.paused || primary.ended) {
            const nextIndex = this.videos.findIndex((video) => !video.paused && !video.ended);
            if (nextIndex < 0) {
                this._stopSync();
                this._emit();
                return;
            }
            this.setPrimary(nextIndex);
            primary = this.primary;
        }
        const target = primary.currentTime;
        for (let i = 0; i < this.videos.length; i++) {
            const video = this.videos[i];
            if (i === this.primaryIndex || video.paused || video.ended || video.readyState < 2) {
                continue;
            }
            const drift = video.currentTime - target;
            if (Math.abs(drift) > this.hardDrift) {
                video.currentTime = Math.min(target, Math.max(0, (video.duration || target) - 0.01));
                video.playbackRate = this.baseRate;
            } else if (Math.abs(drift) > this.softDrift) {
                const adjustment = drift > 0 ? -0.05 : 0.05;
                video.playbackRate = Math.max(0.25, Math.min(2, this.baseRate + adjustment));
            } else if (video.playbackRate !== this.baseRate) {
                video.playbackRate = this.baseRate;
            }
        }
        this._emit();
    }

    _emit() {
        this.onState({
            paused: this.paused,
            currentTime: this.currentTime,
            duration: this.duration,
            rate: this.baseRate,
            primaryIndex: this.primaryIndex,
        });
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this.pause();
        for (const video of this.videos) {
            video.removeEventListener('timeupdate', this._onTime);
            video.removeEventListener('durationchange', this._onMediaState);
            video.removeEventListener('play', this._onMediaState);
            video.removeEventListener('pause', this._onMediaState);
            video.removeEventListener('ended', this._onMediaState);
            video.removeAttribute('src');
            video.load();
        }
    }
}
