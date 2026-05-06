const LEGACY_YANDEX_HOST = 'storage.yandexcloud.net';
const GOOGLE_STORAGE_HOST = 'storage.googleapis.com';
const LEGACY_BUCKET = 'mopsstars-snapshots';
const ACTIVE_BUCKET = 'mopsstars-snapshots-gcp';

function normalizeBucketPath(pathname: string): string {
  const legacyPrefix = `/${LEGACY_BUCKET}/`;
  if (pathname.startsWith(legacyPrefix)) {
    return pathname.replace(legacyPrefix, `/${ACTIVE_BUCKET}/`);
  }
  return pathname;
}

export function normalizeSnapshotStorageUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  if (parsed.hostname === LEGACY_YANDEX_HOST) {
    parsed.hostname = GOOGLE_STORAGE_HOST;
    parsed.pathname = normalizeBucketPath(parsed.pathname);
    return parsed.toString();
  }

  if (parsed.hostname === GOOGLE_STORAGE_HOST) {
    parsed.pathname = normalizeBucketPath(parsed.pathname);
    return parsed.toString();
  }

  return rawUrl;
}
