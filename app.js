/* Мапа районів Львова: зелені зони (хочу тут жити), червоні (не рекомендують),
   пошук адреси через OSM Nominatim + перевірка, у якій зоні точка. */

const LVIV_CENTER = [49.8397, 24.0297];
const LVIV_VIEWBOX = '23.85,49.92,24.15,49.75'; // lng1,lat1,lng2,lat2 для Nominatim
const LVIV_VIEWBOX_PHOTON = '23.85,49.75,24.15,49.92'; // minLon,minLat,maxLon,maxLat для Photon

const STYLE = {
  good:  { color: '#15803d', weight: 2, fillColor: '#22c55e', fillOpacity: 0.25 },
  avoid: { color: '#b91c1c', weight: 2, fillColor: '#f87171', fillOpacity: 0.18 }
};

const map = L.map('map').setView(LVIV_CENTER, 12);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function bindZone(layer) {
  const p = layer.feature.properties;
  const badge = p.status === 'good'
    ? '<span class="badge good">🟢 Рекомендовано тут жити</span>'
    : '<span class="badge avoid">🔴 Не рекомендують</span>';
  layer.bindPopup(
    `<div class="zone-popup"><b>${esc(p.name)}</b><br>${badge}<p>${esc(p.description)}</p></div>`
  );
  layer.on('mouseover', () => layer.setStyle({ fillOpacity: 0.45 }));
  layer.on('mouseout',  () => layer.setStyle(STYLE[p.status] || STYLE.good));
}

const zonesLayer = L.geoJSON(window.DISTRICTS, {
  style: f => STYLE[f.properties.status] || STYLE.good,
  onEachFeature: (f, layer) => bindZone(layer)
}).addTo(map);

/* ---------- Легенда ---------- */
const legend = L.control({ position: 'bottomright' });
legend.onAdd = () => {
  const div = L.DomUtil.create('div', 'legend');
  div.innerHTML =
    '<div><span class="swatch" style="background:#22c55e"></span>Рекомендовано тут жити</div>' +
    '<div><span class="swatch" style="background:#f87171"></span>Не рекомендують</div>';
  return div;
};
legend.addTo(map);

/* ---------- Точка в полігоні (ray casting, even-odd по всіх кільцях) ---------- */
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function zoneAt(lat, lng) {
  // Якщо точка одночасно в зеленій і червоній зоні — перемагає червона.
  let firstGood = null;
  for (const layer of zonesLayer.getLayers()) {
    const g = layer.feature && layer.feature.geometry;
    if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates]
                : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const rings of polys) {
      let inside = false;
      for (const ring of rings) if (pointInRing(lng, lat, ring)) inside = !inside;
      if (inside) {
        if (layer.feature.properties.status === 'avoid') return layer;
        if (!firstGood) firstGood = layer;
      }
    }
  }
  return firstGood;
}

/* ---------- Пошук адреси (Nominatim) ---------- */
const resultBar = document.getElementById('resultBar');
const searchForm = document.getElementById('searchForm');
const searchInput = document.getElementById('searchInput');
let searchMarker = null;

// «Шувар, 36, проспект Червоної Калини, Шувар, Козельники, …» → перші 3 частини
function shortLabel(displayName) {
  return String(displayName).split(',').slice(0, 3).join(',').trim();
}

function showResult(html, cls) {
  resultBar.className = cls || '';
  resultBar.innerHTML = html;
  resultBar.style.display = 'block';
}

function placeResult(lat, lng, label) {
  const zone = zoneAt(lat, lng);
  let verdict, cls;
  if (!zone) {
    verdict = '⚪ Поза позначеними зонами';
    cls = '';
  } else if (zone.feature.properties.status === 'good') {
    verdict = `✅ У зеленій зоні: <b>${esc(zone.feature.properties.name)}</b>`;
    cls = 'good';
  } else {
    verdict = `❌ У червоній зоні: <b>${esc(zone.feature.properties.name)}</b>`;
    cls = 'avoid';
  }
  showResult(`${verdict}<br><small>${esc(label)}</small>`, cls);

  if (searchMarker) map.removeLayer(searchMarker);
  searchMarker = L.marker([lat, lng]).addTo(map)
    .bindPopup(`<div class="zone-popup">${verdict}<p>${esc(label)}</p></div>`)
    .openPopup();
  map.setView([lat, lng], Math.max(map.getZoom(), 15));
}

async function geocode(query) {
  const q = /львів/i.test(query) ? query : query + ', Львів';
  const url = 'https://nominatim.openstreetmap.org/search' +
    `?format=jsonv2&limit=5&accept-language=uk&bounded=1&viewbox=${LVIV_VIEWBOX}` +
    `&q=${encodeURIComponent(q)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/* ---------- Підказки під час введення (Photon, безкоштовний OSM-геокодер) ---------- */
const suggestionsBox = document.getElementById('suggestions');
let suggestItems = [];
let suggestHl = -1;
let suggestTimer = null;
let suggestAbort = null;

function photonLabel(f) {
  const p = f.properties;
  const main = p.name || [p.street, p.housenumber].filter(Boolean).join(' ') || '';
  const extra = [p.street && p.name ? [p.street, p.housenumber].filter(Boolean).join(' ') : '', p.district, p.city]
    .filter(Boolean).join(', ');
  return { main, extra };
}

function hideSuggestions() {
  suggestionsBox.style.display = 'none';
  suggestionsBox.innerHTML = '';
  suggestItems = [];
  suggestHl = -1;
}

function renderSuggestions() {
  if (!suggestItems.length) { hideSuggestions(); return; }
  suggestionsBox.innerHTML = suggestItems.map((it, i) =>
    `<button type="button" data-i="${i}" class="${i === suggestHl ? 'hl' : ''}">` +
    `${esc(it.main)}${it.extra ? ` <span class="sub">${esc(it.extra)}</span>` : ''}</button>`
  ).join('');
  suggestionsBox.style.display = 'block';
  suggestionsBox.querySelectorAll('button').forEach(btn => {
    // pointerdown спрацьовує до blur інпута, інакше на телефоні список зникає раніше за тап
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pickSuggestion(+btn.dataset.i);
    });
  });
}

function pickSuggestion(i) {
  const it = suggestItems[i];
  if (!it) return;
  searchInput.value = it.main + (it.extra ? ', ' + it.extra : '');
  hideSuggestions();
  placeResult(it.lat, it.lng, it.main + (it.extra ? ', ' + it.extra : ''));
}

async function fetchSuggestions(query) {
  if (suggestAbort) suggestAbort.abort();
  suggestAbort = new AbortController();
  const url = 'https://photon.komoot.io/api/' +
    `?q=${encodeURIComponent(query)}&limit=5&lang=default&bbox=${LVIV_VIEWBOX_PHOTON}`;
  try {
    const res = await fetch(url, { signal: suggestAbort.signal });
    if (!res.ok) return;
    const data = await res.json();
    suggestItems = (data.features || []).map(f => {
      const { main, extra } = photonLabel(f);
      return { main, extra, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
    }).filter(it => it.main);
    suggestHl = -1;
    renderSuggestions();
  } catch (e) {
    if (e.name !== 'AbortError') hideSuggestions();
  }
}

searchInput.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = searchInput.value.trim();
  if (q.length < 3) { hideSuggestions(); return; }
  suggestTimer = setTimeout(() => fetchSuggestions(q), 350);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' && suggestItems.length) {
    e.preventDefault();
    suggestHl = (suggestHl + 1) % suggestItems.length;
    renderSuggestions();
  } else if (e.key === 'ArrowUp' && suggestItems.length) {
    e.preventDefault();
    suggestHl = (suggestHl - 1 + suggestItems.length) % suggestItems.length;
    renderSuggestions();
  } else if (e.key === 'Escape') {
    hideSuggestions();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (suggestHl >= 0) {
      pickSuggestion(suggestHl);
    } else {
      hideSuggestions();
      searchForm.requestSubmit();
    }
  }
});

searchInput.addEventListener('blur', () => setTimeout(hideSuggestions, 200));

searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = searchInput.value.trim();
  if (!query) return;
  showResult('🔎 Шукаю…');
  try {
    const results = await geocode(query);
    if (!results.length) {
      showResult('Нічого не знайдено. Спробуйте, наприклад: «вул. Личаківська 45».');
    } else if (results.length === 1) {
      placeResult(+results[0].lat, +results[0].lon, shortLabel(results[0].display_name));
    } else {
      showResult(
        'Знайдено кілька варіантів — оберіть:' +
        '<div class="picklist">' +
        results.map((r, i) =>
          `<button type="button" data-i="${i}">${esc(shortLabel(r.display_name))}</button>`
        ).join('') +
        '</div>'
      );
      resultBar.querySelectorAll('.picklist button').forEach(btn => {
        btn.addEventListener('click', () => {
          const r = results[+btn.dataset.i];
          placeResult(+r.lat, +r.lon, shortLabel(r.display_name));
        });
      });
    }
  } catch (err) {
    showResult('Помилка пошуку: ' + esc(err.message));
  }
});

/* ---------- Редагування (Leaflet-Geoman) ---------- */
const editBtn = document.getElementById('editBtn');
let editing = false;

map.pm.setGlobalOptions({ snappable: true });

editBtn.addEventListener('click', () => {
  editing = !editing;
  editBtn.classList.toggle('active', editing);
  if (editing) {
    map.pm.addControls({
      position: 'topleft',
      drawPolygon: true,
      editMode: true,
      dragMode: true,
      removalMode: true,
      drawMarker: false, drawCircleMarker: false, drawPolyline: false,
      drawRectangle: false, drawCircle: false, drawText: false,
      cutPolygon: false, rotateMode: false
    });
  } else {
    map.pm.removeControls();
    map.pm.disableGlobalEditMode();
    map.pm.disableGlobalDragMode();
    map.pm.disableGlobalRemovalMode();
  }
});

map.on('pm:create', (e) => {
  const layer = e.layer;
  const name = prompt('Назва району:') || 'Без назви';
  const description = prompt('Опис (покажеться при кліку):') || '';
  const good = confirm('Це зелена зона (хочу тут жити)?\nOK — зелена, Скасувати — червона.');
  const status = good ? 'good' : 'avoid';
  layer.feature = {
    type: 'Feature',
    properties: { name, description, status },
    geometry: layer.toGeoJSON().geometry
  };
  map.removeLayer(layer);
  zonesLayer.addLayer(layer);
  layer.setStyle(STYLE[status]);
  bindZone(layer);
});

/* ---------- Експорт data.js ---------- */
document.getElementById('exportBtn').addEventListener('click', () => {
  const fc = {
    type: 'FeatureCollection',
    features: zonesLayer.getLayers().map(l => {
      const gj = l.toGeoJSON();
      gj.properties = l.feature ? l.feature.properties : {};
      return gj;
    })
  };
  const content =
    '// Дані зон Львова. Згенеровано кнопкою «Зберегти data.js».\n' +
    'window.DISTRICTS = ' + JSON.stringify(fc, null, 2) + ';\n';
  const blob = new Blob([content], { type: 'text/javascript;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'data.js';
  a.click();
  URL.revokeObjectURL(a.href);
  showResult('💾 Файл data.js завантажено. Замініть ним старий data.js у репозиторії та зробіть коміт.');
});
