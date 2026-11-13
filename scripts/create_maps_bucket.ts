// One-off: create a public Supabase Storage bucket for self-hosted basemap
// tiles and upload a PMTiles file. Re-runnable — bucket creation is idempotent,
// and uploads overwrite via `upsert: true`.
//
// Usage: deno run --allow-net --allow-env --allow-read --env-file=.env \
//          scripts/create_maps_bucket.ts <path/to/tanzania.pmtiles>
//
// Why this script exists: the browser (via protomaps-leaflet) range-reads
// the PMTiles file directly from Supabase Storage. A public bucket avoids
// signed-URL rotation and lets the CDN cache tile slices.

import { db } from "../backend/lib/db.ts";
import { getConfig } from "../backend/config.ts";

const BUCKET = "maps";
const OBJECT = "tanzania.pmtiles";

const filePath = Deno.args[0];
if (!filePath) {
  console.error("usage: create_maps_bucket.ts <path/to/tanzania.pmtiles>");
  Deno.exit(1);
}

const storage = db().storage;

// 1. Ensure bucket exists.
const { data: existing } = await storage.getBucket(BUCKET);
if (existing) {
  console.log(`bucket "${BUCKET}" already exists (public=${existing.public})`);
} else {
  const { error } = await storage.createBucket(BUCKET, { public: true });
  if (error) {
    console.error("createBucket failed:", error.message);
    Deno.exit(1);
  }
  console.log(`created public bucket "${BUCKET}"`);
}

// 2. Upload the pmtiles file. Range-read support is what makes this work —
// Supabase Storage forwards Range headers to its upstream, so pmtiles can
// seek into byte offsets without downloading the whole 77 MB.
const bytes = await Deno.readFile(filePath);
console.log(`uploading ${filePath} (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB) -> ${BUCKET}/${OBJECT} …`);
const { error: upErr } = await storage.from(BUCKET).upload(OBJECT, bytes, {
  contentType: "application/octet-stream",
  cacheControl: "public, max-age=31536000, immutable",
  upsert: true,
});
if (upErr) {
  console.error("upload failed:", upErr.message);
  Deno.exit(1);
}

// 3. Print the public URL — paste this into locations.js.
const { data: pub } = storage.from(BUCKET).getPublicUrl(OBJECT);
const cfg = getConfig();
console.log("");
console.log("done.");
console.log("public url:", pub.publicUrl);
console.log("project url:", cfg.supabaseUrl);
