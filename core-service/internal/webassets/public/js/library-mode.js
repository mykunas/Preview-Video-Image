// Local UI policy: browse, organise and play the existing media library.
export const LIBRARY_MODE = true;
export const HIDDEN_SETTINGS = '#settings-accounts, #settings-downloads, #settings-network, #settings-federation, #settings-card-engine, #settings-card-advanced-details';
export function hiddenElement(element) {
    return !!element?.closest?.(HIDDEN_SETTINGS);
}
export function hiddenRoute(raw) {
    const path = String(raw || '').replace(/^#/, '').split('?')[0];
    return /^\/(groups|backfill|queue|engine|stories|account)(\/|$)/.test(path)
        || /^\/settings\/(system|engine|monitor|accounts|tg-api|telegram-api|downloads|download|network|federation|card-(engine|accounts|tg-api|download|size|rescue|advanced|federation))(\/|$)/.test(path)
        || /^\/(?:settings\/tools\/[^/]+\/|maintenance\/)(recovery|cluster|updates)(\/|$)/.test(path);
}
