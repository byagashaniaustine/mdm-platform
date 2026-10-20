import { api, del, get, post } from "../api.js";
import { ago, badge, clear, emptyState, field, fmtTime, h, icon, input, loading, modal, pageHeader, responsive, select, toast, toastError } from "../ui.js";

const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const STALE_MS = 6 * 3600_000;

function leafletReady() {
  if (window.L) return Promise.resolve(window.L);
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const check = () => {
      if (window.L) resolve(window.L);
      else if (Date.now() - t0 > 10_000) reject(new Error("Map library failed to load"));
      else setTimeout(check, 50);
    };
    check();
  });
}

/** Render devices as dots and geofences as circles on an OpenStreetMap tile layer. */
function tileMap(points, fences, names) {
  if (!points.length && !fences.length) return null;
  const container = h("div", { class: "map", role: "img", "aria-label": "Device locations and geofences" });

  queueMicrotask(async () => {
    try {
      const L = await leafletReady();
      if (!container.isConnected) return;
      const css = getComputedStyle(document.documentElement);
      const ok = css.getPropertyValue("--ok").trim() || "#3F6B4F";
      const bad = css.getPropertyValue("--bad").trim() || "#9B3326";
      const copper = css.getPropertyValue("--copper").trim() || "#C18064";
      const charcoal = css.getPropertyValue("--charcoal").trim() || "#1D1D1B";
      const stone = css.getPropertyValue("--stone").trim() || "#BBB7B6";

      const map = L.map(container, { scrollWheelZoom: false, zoomControl: true });
      L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIB }).addTo(map);
      L.control.scale({ metric: true, imperial: false }).addTo(map);

      const latLngs = [];
      for (const f of fences) {
        const color = f.kind === "restricted" ? bad : ok;
        const circle = L.circle([f.latitude, f.longitude], {
          radius: f.radius_m,
          color,
          weight: 2,
          fillColor: color,
          fillOpacity: 0.12,
          dashArray: f.kind === "restricted" ? "6 4" : null,
        }).addTo(map);
        circle.bindTooltip(f.name, { permanent: true, direction: "top", className: "map-tip" });
        latLngs.push(circle.getBounds().getNorthEast(), circle.getBounds().getSouthWest());
      }
      for (const p of points) {
        const stale = Date.now() - Date.parse(p.located_at) > STALE_MS;
        const marker = L.circleMarker([p.latitude, p.longitude], {
          radius: 7,
          color: stale ? stone : copper,
          weight: 2,
          fillColor: stale ? stone : charcoal,
          fillOpacity: 1,
        }).addTo(map);
        const name = names.get(p.device_id) ?? "device";
        marker.bindTooltip(name, { direction: "right", offset: [10, 0], className: "map-tip" });
        const popup = h("div", {}, h("strong", {}, name), h("br"), fmtTime(p.located_at));
        marker.bindPopup(popup);
        latLngs.push([p.latitude, p.longitude]);
      }

      if (latLngs.length) map.fitBounds(L.latLngBounds(latLngs), { padding: [30, 30], maxZoom: 16 });
      else map.setView([0, 0], 2);
      map.invalidateSize();
    } catch (err) {
      container.replaceChildren(h("p", { class: "muted", style: "padding: 16px;" }, err?.message ?? "Map failed to load."));
    }
  });

  return container;
}

export async function locationsView(el, ctx) {
  clear(el, loading());
  if (!ctx.can("admin")) {
    return clear(el, pageHeader("Locations"), emptyState("Admins only", "Location is personal data — only owners and admins can view it."));
  }
  const [latest, fences, devices, groups, settings] = await Promise.all([
    get("/api/locations/latest"),
    get("/api/locations/geofences"),
    get("/api/devices"),
    get("/api/groups"),
    get("/api/monitoring/settings"),
  ]);
  const names = new Map(devices.map((d) => [d.id, d.device_name]));
  const enabledFences = fences.filter((f) => f.enabled);

  const historyBox = h("div");
  const showHistory = async (d) => {
    clear(historyBox, loading());
    const pts = await get(`/api/locations/device/${d.id}?hours=24`);
    clear(historyBox,
      h("h3", {}, `${d.device_name} — last 24 h (${pts.length} points)`),
      pts.length ? h("div", { class: "map-wrap" }, tileMap(pts.map((p) => ({ ...p, device_id: d.id })), enabledFences, names)) : h("p", { class: "muted" }, "No points in the last 24 hours."),
    );
  };

  const fenceForm = () => {
    const name = input({ maxlength: 100, placeholder: "Head office" });
    const kind = select([{ value: "allowed", label: "Allowed area — alert when a device leaves" }, { value: "restricted", label: "Restricted area — alert when a device enters" }]);
    const lat = input({ type: "number", step: "0.000001", placeholder: "-6.816100" });
    const lon = input({ type: "number", step: "0.000001", placeholder: "39.280300" });
    const radius = input({ type: "number", min: 50, max: 50000, value: 500 });
    const group = select([{ value: "", label: "All devices" }, ...groups.map((g) => ({ value: g.id, label: g.name }))]);
    const hours = h("input", { type: "checkbox", checked: true });
    const from = select([{ value: "", label: "— use a device's last location —" }, ...latest.points.map((p) => ({ value: p.device_id, label: names.get(p.device_id) ?? p.device_id }))]);
    from.addEventListener("change", () => {
      const p = latest.points.find((x) => x.device_id === from.value);
      if (p) {
        lat.value = p.latitude.toFixed(6);
        lon.value = p.longitude.toFixed(6);
      }
    });
    modal("New geofence", h("div", { class: "stack" },
      field("Name", name), field("Type", kind),
      latest.points.length ? field("Centre from device", from) : null,
      h("div", { class: "grid2" }, field("Latitude", lat), field("Longitude", lon)),
      field("Radius (metres)", radius), field("Applies to", group),
      h("label", { class: "pick" }, hours, h("span", {}, "Only check during working hours")),
      h("p", { class: "hint" }, "Tip: right-click a spot in Google Maps / OpenStreetMap to copy its coordinates."),
    ), [
      { label: "Cancel" },
      { label: "Create", tone: "primary", onClick: async () => {
        await post("/api/locations/geofences", { name: name.value, kind: kind.value, latitude: Number(lat.value), longitude: Number(lon.value), radiusM: Number(radius.value), groupId: group.value || null, activeHoursOnly: hours.checked });
        toast("Geofence created");
        locationsView(el, ctx);
      } },
    ]);
  };

  const osm = (p) => `https://www.openstreetmap.org/?mlat=${p.latitude}&mlon=${p.longitude}#map=16/${p.latitude}/${p.longitude}`;
  const map = tileMap(latest.points, enabledFences, names);

  clear(
    el,
    pageHeader("Locations", `Corporate devices only. Points are kept ${settings.location_retention_days} days and every view is logged.`, [
      h("button", { class: "btn btn-primary", type: "button", onclick: fenceForm }, icon("plus"), "New geofence"),
    ]),
    !settings.location_tracking_enabled
      ? h("div", { class: "banner banner-warn" }, h("strong", {}, "Location tracking is off. "), "Geofences only work when it is on. ", ctx.can("owner") ? h("a", { href: "#/settings?tab=monitoring" }, "Turn it on in Settings → Monitoring") : "Ask the owner to enable it.")
      : null,
    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "Map"), h("span", { class: "muted small" }, "Dot = device · green ring = allowed area · red ring = restricted area · grey = older than 6 h")),
      map ? h("div", { class: "map-wrap" }, map) : h("p", { class: "muted" }, "No location points yet."),
    ),
    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "Last known position")),
      latest.points.length
        ? h("div", { class: "table-wrap" }, responsive(h("table", {},
          h("thead", {}, h("tr", {}, h("th", {}, "Device"), h("th", {}, "Coordinates"), h("th", {}, "Seen"), h("th", {}, ""))),
          h("tbody", {}, latest.points.map((p) => {
            const d = devices.find((x) => x.id === p.device_id) ?? { id: p.device_id, device_name: "device" };
            return h("tr", {},
              h("td", {}, d.device_name),
              h("td", { class: "mono" }, `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`),
              h("td", { class: "muted" }, ago(p.located_at)),
              h("td", { class: "actions" },
                h("button", { class: "btn btn-sm", type: "button", onclick: () => showHistory(d).catch(toastError) }, "24 h trail"),
                h("a", { class: "btn btn-sm btn-ghost", href: osm(p), target: "_blank", rel: "noopener noreferrer" }, "Open map")),
            );
          })),
        )))
        : h("p", { class: "muted" }, "Nothing collected yet."),
      historyBox,
    ),
    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("h2", {}, "Geofences")),
      fences.length
        ? h("ul", { class: "list" }, fences.map((f) =>
          h("li", {},
            h("span", {}, badge(f.kind, f.kind === "restricted" ? "bad" : "ok"), h("strong", {}, f.name),
              h("span", { class: "muted small" }, ` · ${f.radius_m} m · ${f.groups?.name ?? "all devices"}${f.active_hours_only ? " · working hours" : " · always"}`)),
            h("span", { class: "btn-row" },
              h("button", { class: "btn btn-xs", type: "button", onclick: async () => {
                try {
                  await api("PATCH", `/api/locations/geofences/${f.id}`, { enabled: !f.enabled });
                  locationsView(el, ctx);
                } catch (err) {
                  toastError(err);
                }
              } }, f.enabled ? "Disable" : "Enable"),
              h("button", { class: "btn btn-xs btn-ghost", type: "button", onclick: async () => {
                try {
                  await del(`/api/locations/geofences/${f.id}`);
                  toast("Geofence deleted", "info");
                  locationsView(el, ctx);
                } catch (err) {
                  toastError(err);
                }
              } }, "Delete")),
          )))
        : h("p", { class: "muted" }, "No geofences. Add an allowed area around the office or a client site."),
    ),
  );
}
