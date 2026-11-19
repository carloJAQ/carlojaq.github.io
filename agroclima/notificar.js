// AgroClima · aviso automático (lo corre GitHub Actions todos los días).
// 1) Hace una consulta a Supabase para que el proyecto gratis no se pause.
// 2) Todos los días (o si FORZAR=1) calcula el resumen completo y manda la notificación
//    a los teléfonos que activaron los avisos en la app.
// 3) Cada 15 minutos manda los mensajes escritos a mano en la app (tabla ac_mensajes) cuando llega su hora.
// Usa el mismo código de cálculo que la app: lo baja de la página publicada.
const vm = require('vm');
let webpush = null;

const APP = process.env.APP_URL || 'https://carlojaq.github.io/agroclima/';
const SB_URL = 'https://gdrnstimuliiyxsmvujq.supabase.co';
const VAPID_PUB = process.env.VAPID_PUBLIC;
const VAPID_PRIV = process.env.VAPID_PRIVATE;
const DIAS_AVISO = [0, 1, 2, 3, 4, 5, 6]; // todos los días

const pad = n => String(n).padStart(2, '0');
const hoyStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const ahoraStr = () => `${hoyStr()}T${pad(new Date().getHours())}:00`;
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const fCorta = s => { const [y, m, d] = s.split('-').map(Number); return `${DIAS[new Date(y, m - 1, d).getDay()]} ${d}/${m}`; };

async function main() {
  const html = await (await fetch(APP + 'index.html?x=' + Date.now())).text();
  const KEY = (html.match(/sb_publishable_[A-Za-z0-9_-]+/) || [])[0];
  if (!KEY) throw new Error('No encontré la clave pública en la app publicada.');
  const sb = async (method, path, body) => {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { method, headers: { apikey: KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return method === 'GET' ? r.json() : null;
  };
  // 1) mantener activo
  const lotesTodos = await sb('GET', 'ac_lotes?select=*');
  console.log(`Supabase activo: ${lotesTodos.length} lotes.`);

  // 3) mensajes manuales cuya hora ya llegó
  const subsM = VAPID_PRIV ? await sb('GET', 'ac_push?select=*&activo=eq.true') : [];
  const pend = await sb('GET', `ac_mensajes?select=*&enviado_en=is.null&enviar_en=lte.${encodeURIComponent(new Date().toISOString())}&order=enviar_en.asc`).catch(e => { console.log('Tabla de mensajes no disponible:', e.message); return []; });
  if (pend.length && !VAPID_PRIV) console.log('Hay mensajes pendientes pero falta VAPID_PRIVATE.');
  for (const m of VAPID_PRIV ? pend : []) {
    const r = await enviar(subsM, { title: m.titulo || 'INIA La Pampa', body: m.texto || '', url: './#mensajes', tag: 'msg-' + m.id }, 24 * 3600, sb);
    await sb('PATCH', `ac_mensajes?id=eq.${m.id}`, { enviado_en: new Date().toISOString(), enviados: r.ok });
    console.log(`Mensaje "${(m.titulo || '').slice(0, 40)}" enviado a ${r.ok} de ${subsM.length} teléfonos.`);
  }
  const CRON = process.env.CRON || '';
  if (CRON && CRON !== '13 10 * * *') { console.log('Pasada de mensajes lista.'); return; }

  const dia = new Date().getDay();
  if (process.env.FORZAR !== '1' && !DIAS_AVISO.includes(dia)) { console.log('Hoy no toca aviso.'); return; }
  if (!VAPID_PRIV) { console.log('Falta el secreto VAPID_PRIVATE: no se envían avisos.'); return; }

  // 2) cargar el código de cálculo de la app (modelos + contenido + calendario)
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const mod = scripts.find(s => s.includes('const M = (() =>'));
  const con = scripts.find(s => s.includes('const G = (() =>'));
  const ctx = vm.createContext({ console, Math, Date, JSON, Intl, Object, Array, String, Number, RegExp, Set, Map, isFinite, isNaN });
  vm.runInContext(mod + '\n' + con + '\nglobalThis.__X = { M, G, CAL };', ctx);
  const { M, G, CAL } = ctx.__X;

  const [apps, cfgs, subs] = await Promise.all([sb('GET', 'ac_aplicaciones?select=*'), sb('GET', 'ac_config?id=eq.general&select=datos'), sb('GET', 'ac_push?select=*&activo=eq.true')]);
  const prods = await sb('GET', 'ac_productos?select=*').catch(() => []);
  const visitas = await sb('GET', 'ac_visitas?select=lote_id,fecha,ajuste_gd').catch(() => []);
  if (!subs.length) { console.log('Nadie activó las notificaciones todavía.'); return; }
  const CFG = Object.assign(JSON.parse(JSON.stringify(M.CONFIG)), (cfgs[0] && cfgs[0].datos) || {});
  const CULT = { papa: 1, trigo: 1, avena: 1, cebada: 1 };
  const lotes = lotesTodos.filter(l => l.activo !== false && l.fecha_plantacion && CULT[l.cultivo] && l.lat != null);
  lotes.forEach(l => { l.fecha_plantacion = String(l.fecha_plantacion).slice(0, 10); });
  const hoy = hoyStr();

  // clima: un pronóstico por punto (redondeado ~1 km) desde la plantación más antigua del grupo
  const grupos = {};
  lotes.forEach(l => { const k = `${(+l.lat).toFixed(2)},${(+l.lon).toFixed(2)}`; (grupos[k] = grupos[k] || []).push(l); });
  const base = (lat, lon) => `latitude=${lat}&longitude=${lon}&hourly=${CAL.VARS}&timezone=America%2FSantiago&wind_speed_unit=kmh`;
  const aSerie = j => { const h = { time: j.hourly.time }; for (const k in CAL.CLAVES) h[CAL.CLAVES[k]] = j.hourly[k] || []; return h; };
  async function clima(lat, lon, desde) {
    const atras = Math.max(1, M.difDias(desde, hoy) + 1);
    const F = aSerie(await (await fetch(`https://api.open-meteo.com/v1/forecast?${base(lat, lon)}&past_days=${Math.min(92, atras)}&forecast_days=7`)).json());
    if (atras <= 92) return F;
    const A = aSerie(await (await fetch(`https://archive-api.open-meteo.com/v1/archive?${base(lat, lon)}&start_date=${desde}&end_date=${M.sumarDias(hoy, -91)}`)).json());
    const set = new Set(F.time), h = { time: [] }; Object.values(CAL.CLAVES).forEach(k => h[k] = []);
    A.time.forEach((t, i) => { if (set.has(t)) return; h.time.push(t); Object.values(CAL.CLAVES).forEach(k => h[k].push(A[k][i])); });
    F.time.forEach((t, i) => { h.time.push(t); Object.values(CAL.CLAVES).forEach(k => h[k].push(F[k][i])); });
    return h;
  }
  const res = []; let refH = null;
  for (const k in grupos) {
    const g = grupos[k], desde = g.map(l => l.fecha_plantacion).sort()[0];
    let h; try { h = await clima(g[0].lat, g[0].lon, desde); } catch (e) { console.log('Clima falló en', k, e.message); continue; }
    if (!refH) refH = h;
    const dias = M.diario(h, CFG);
    for (const l of g) {
      const S = M.serie(dias, l, CFG), ap = apps.filter(a => a.lote_id === l.id).map(a => Object.assign({}, a, { fecha: String(a.fecha).slice(0, 10) }));
      const dec = M.decidir(S.dias, l, ap, hoy, CFG);
      const pas = S.dias.filter(d => d.fecha <= hoy), fut = S.dias.filter(d => d.fecha > hoy), hd = pas[pas.length - 1];
      const prom = pas.slice(-7).concat(fut.slice(0, 7)); const gdProm = prom.length ? prom.reduce((t, d) => t + d.gd, 0) / prom.length : 0;
      const fechaGD = gd => { const d = S.dias.find(x => x.gdAc >= gd); if (d) return d.fecha; if (!hd || gdProm <= 0.3) return null; return M.sumarDias(hoy, Math.ceil((gd - hd.gdAc) / gdProm)); };
      const et = (CFG[l.cultivo] || CFG.papa).etapas, gdE = re => (et.find(e => re.test(e.n)) || {}).gd;
      const vis = visitas.filter(x => x.lote_id === l.id && String(x.fecha).slice(0, 10) <= hoy).sort((a, b) => a.fecha < b.fecha ? 1 : -1)[0], aj = vis ? +vis.ajuste_gd || 0 : 0;
      const etp = hd ? M.etapa(hd.gdAc, l, CFG, gdProm, hoy, aj) : null;
      const r = { l, dec: dec.global, por: dec.por || [], prox: [], pend: [], insp: [], cambio: null, gd: hd ? hd.gdAc + aj : null, etapa: etp ? etp.actual : null, gdProm };
      if (hd) { const ay = S.dias.find(x => x.fecha === M.sumarDias(hoy, -1)), g0 = (ay ? ay.gdAc : hd.gdAc) + aj, g3 = hd.gdAc + aj + 3 * gdProm; r.cambios = et.filter(x => x.gd > g0 && x.gd <= g3).map(x => ({ n: x.n, f: fechaGD(x.gd - aj) || hoy })); }
      if (l.cultivo === 'papa') {
        const ev = CAL.eventos((l.norma || {}).prog || 'lp'); CAL.cruzar(l, ev, ap);
        r.prox = ev.filter(e => !e.app && e.fecha >= hoy && e.fecha <= M.sumarDias(hoy, 2));
        r.pend = ev.filter(e => !e.app && e.fecha < hoy && e.fecha >= M.sumarDias(hoy, -7));
      }
      if (l.categoria) {
        const ws = l.cultivo === 'papa' ? [['1ª insp.', /Emergencia/, /Floraci/], ['2ª insp.', /Floraci/, /Desarrollo de tub/]] : [['insp.', /Z75/, /Z85/]];
        ws.forEach(([t, a, b]) => { const fa = fechaGD(gdE(a)), fb = fechaGD(gdE(b)); if (fa && fb && fb >= hoy && fa <= M.sumarDias(hoy, 7)) r.insp.push({ t, fa, fb }); });
      }
      res.push(r);
    }
  }
  if (!refH) throw new Error('No se pudo bajar el pronóstico.');
  const Sm = CAL.semana(refH, hoy, CFG), ven = M.ventanas(refH, ahoraStr(), CFG, 72);
  const corto = n => String(n).split(' · ')[0].replace(/\b(\w)(\w*)/g, (m, a, b) => a + b.toLowerCase());
  const aplicar = res.filter(r => r.prox.length || r.pend.length || r.dec === 'APLICAR');
  const D = M.diario(refH, CFG), dh = D.find(d => d.fecha === hoy) || {}, pas7 = D.filter(d => d.fecha < hoy && d.fecha >= M.sumarDias(hoy, -7)), fut7 = D.filter(d => d.fecha > hoy && d.fecha <= M.sumarDias(hoy, 7));
  const sum = (a, k) => a.reduce((t, d) => t + (d[k] || 0), 0), r1 = x => Math.round(x * 10) / 10, r0 = x => Math.round(x), vmax = CFG.aplicacion.vientoMax;
  const dS = f => fCorta(f).split(' ')[0], ctl = l => l.numero_control ? 'N° ' + l.numero_control : String(l.nombre || '').split(' · ')[0];
  const lin = [];
  // 1) clima de hoy y horas para aplicar
  lin.push(`🌡 Hoy ${r0(dh.tmin)}–${r0(dh.tmax)} °C · lluvia ${r1(dh.pp || 0)} mm · HR ${r0(dh.hr || 0)} % · viento máx ${r0(dh.viento || 0)} km/h, ráfagas ${r0(dh.rafaga || 0)}`);
  const vHoyL = ven.lista.filter(v => v.ini.slice(0, 10) === hoy), hh = v => `${v.ini.slice(11, 13)}–${pad(+v.fin.slice(11, 13) + 1)} h`;
  const vSig = ven.lista.find(v => v.ini.slice(0, 10) > hoy);
  lin.push(vHoyL.length ? `✅ Se puede aplicar hoy: ${vHoyL.map(hh).join(', ')} (viento <${vmax} km/h y sin lluvia)` : `⛔ Hoy no hay horas aptas para aplicar${vSig ? ` · próxima ventana ${dS(vSig.ini.slice(0, 10))} ${hh(vSig)}` : ''}`);
  // 2) próximos días: temperatura, lluvia y viento por día
  lin.push('📅 ' + fut7.slice(0, 5).map(d => `${dS(d.fecha)} ${r0(d.tmin)}/${r0(d.tmax)}° ${r1(d.pp)}mm ${r0(d.viento)}km/h${d.viento >= vmax ? '⚠' : ''}`).join(' · '));
  lin.push(`💧 Lluvia últimos 7 días ${r0(sum(pas7, 'pp'))} mm · próximos 7 días ${r0(sum(fut7, 'pp'))} mm`);
  const hel = D.filter(d => d.fecha >= hoy && d.fecha <= M.sumarDias(hoy, 7) && d.tmin <= 1);
  if (hel.length) lin.push(`❄️ Riesgo de helada: ${hel.map(d => `${dS(d.fecha)} (${r1(d.tmin)} °C)`).join(', ')}`);
  // 3) tizón
  const papas = res.filter(r => r.l.cultivo === 'papa'), apl = papas.filter(r => r.dec === 'APLICAR'), nV = papas.filter(r => r.dec === 'VIGILAR').length;
  if (papas.length) lin.push(`🍂 Tizón: ${apl.length ? `APLICAR en ${apl.map(r => ctl(r.l)).join(', ')}` : 'ningún lote en APLICAR'}${nV ? ` · vigilar ${nV}` : ''}`);
  // 4) aplicaciones del calendario por número de control
  if (aplicar.length) {
    const pr = e => String(e.prod).split(/ \(| o /)[0];
    const it = aplicar.filter(r => r.prox.length || r.pend.length).sort((a, b) => (b.prox.length ? 1 : 0) - (a.prox.length ? 1 : 0) || b.pend.length - a.pend.length).map(r => { const dias = {}; r.prox.forEach(e => (dias[e.fecha] = dias[e.fecha] || []).push(pr(e))); const t = Object.keys(dias).sort().map(f => `${f === hoy ? 'hoy' : dS(f)} ${dias[f].join(', ')}`); if (r.pend.length) t.push(`${r.pend.length} atrasada${r.pend.length > 1 ? 's' : ''}`); return `${ctl(r.l)}: ${t.join('; ')}`; });
    lin.push(`🧪 Aplicar\n${it.slice(0, 8).map(x => '  • ' + x).join('\n')}${it.length > 8 ? `\n  • y ${it.length - 8} solicitudes más` : ''}`);
  } else lin.push('🧪 Sin aplicaciones del calendario para hoy y los próximos 2 días');
  // 5) cambios de etapa por número de control (desde ayer hasta 3 días más)
  const cam = res.filter(r => r.cambios && r.cambios.length).flatMap(r => r.cambios.map(c => ({ r, c }))).sort((a, b) => a.c.f < b.c.f ? -1 : 1);
  if (cam.length) lin.push(`🌱 Cambio de etapa: ${cam.slice(0, 8).map(x => `${ctl(x.r.l)} → ${x.c.n} (${x.c.f <= hoy ? (x.c.f === hoy ? 'hoy' : 'ayer') : dS(x.c.f)})`).join(' · ')}${cam.length > 8 ? ` · y ${cam.length - 8} más` : ''}`);
  // 6) bodega y SAG
  if (prods.some(p => p.stock != null)) {
    const Bd = CAL.balance(lotes, apps.map(a => Object.assign({}, a, { fecha: String(a.fecha).slice(0, 10) })), prods, hoy, M.sumarDias(hoy, 3));
    const fb = Bd.filas.filter(f => (f.estado === 'sin' || f.estado === 'falta') && f.n);
    if (fb.length) lin.push('📦 Falta en bodega: ' + fb.slice(0, 3).map(f => f.estado === 'sin' ? f.nombre : `${f.nombre} (faltan ${Math.ceil(f.falta)} ${f.U})`).join(', '));
  }
  const ins = res.filter(r => r.insp.length);
  if (ins.length) lin.push(`🔍 Inspección SAG esta semana: ${ins.map(r => ctl(r.l)).join(', ')}`);
  const cuerpo = lin.join('\n');
  const msg = { title: `AgroClima · ${fCorta(hoy)}`, body: cuerpo.length > 1800 ? cuerpo.slice(0, 1797) + '…' : cuerpo, url: './#hoy', tag: 'agroclima-' + hoy };
  console.log('Aviso:', JSON.stringify(msg));

  const r = await enviar(subs, msg, 6 * 3600, sb);
  console.log(`Enviado a ${r.ok} de ${subs.length} teléfonos.`);
}
async function enviar(subs, msg, ttl, sb) {
  if (!webpush) { webpush = require('web-push'); webpush.setVapidDetails('mailto:agroclima@carlojaq.github.io', VAPID_PUB, VAPID_PRIV); }
  let ok = 0;
  for (const s of subs) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg), { TTL: ttl }); ok++; }
    catch (e) { console.log('Falló un teléfono:', e.statusCode || e.message); if (e.statusCode === 404 || e.statusCode === 410) await sb('DELETE', `ac_push?id=eq.${encodeURIComponent(s.id)}`); }
  }
  return { ok };
}
main().catch(e => { console.error(e); process.exit(1); });
