// Configuración de la base de datos local IndexedDB (Dexie.js)
const db = new Dexie("FeriaDB");
db.version(1).stores({
  productos: 'codigo, detalle, precio_costo, precio_ref, stock, tipo, foto_path',
  ventas: '++id, fecha, codigo, detalle, costo_unit, precio_venta, cantidad, ganancia',
  insumos: '++id, nombre, unidad, costo_unitario, stock',
  recetas: '[codigo_prod+id_insumo], codigo_prod, id_insumo, cantidad_usada',
  configuracion: 'clave, valor'
});

// Versión 2: historial de compras de insumos y de producción
db.version(2).stores({
  productos: 'codigo, detalle, precio_costo, precio_ref, stock, tipo, foto_path',
  ventas: '++id, fecha, codigo, detalle, costo_unit, precio_venta, cantidad, ganancia',
  insumos: '++id, nombre, unidad, costo_unitario, stock',
  recetas: '[codigo_prod+id_insumo], codigo_prod, id_insumo, cantidad_usada',
  configuracion: 'clave, valor',
  compras: '++id, fecha, id_insumo',
  producciones: '++id, fecha'
});

let productoSeleccionadoVenta = null;
let filtroConsultaActual = 'todos';
let ultimosFaltantesCompras = [];
let chartVentasInstancia = null;
let insumoEnEdicionId = null;

// ===== FECHAS EN HORA LOCAL =====
// Antes se guardaba toISOString() (UTC): en Argentina, las ventas hechas despues de las 21:00
// quedaban con la fecha del dia siguiente. Ahora se guarda la hora local del celular.
function pad2(n) { return String(n).padStart(2, '0'); }
function fechaLocalISO(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function hoyLocal(d = new Date()) { return fechaLocalISO(d).substring(0, 10); }
// Las ventas viejas (guardadas en UTC, con "Z") se convierten a hora local al leerlas
function normalizarFecha(f) {
  if (typeof f !== 'string') return '';
  if (/T.*(Z|[+-]\d\d:?\d\d)$/.test(f)) {
    const d = new Date(f);
    if (!isNaN(d.getTime())) return fechaLocalISO(d);
  }
  return f;
}

// ===== UNIDADES DE MEDIDA =====
// Cada linea de receta guarda la unidad en que se usa el insumo (unidad_uso).
// Al descontar stock y calcular costos se convierte a la unidad del insumo.
const UNIDADES_USO = { kg: ['kg', 'g'], g: ['g', 'kg'], litros: ['litros', 'ml'], m: ['m', 'cm'], un: ['un'] };
const FACTORES_UNIDAD = { 'g>kg': 0.001, 'kg>g': 1000, 'ml>litros': 0.001, 'litros>ml': 1000, 'cm>m': 0.01, 'm>cm': 100 };

function normUnidad(u) {
  u = (u || '').toString().toLowerCase().trim();
  if (['l', 'lt', 'lts', 'litro', 'litros'].includes(u)) return 'litros';
  if (['kg', 'kilo', 'kilos'].includes(u)) return 'kg';
  if (['g', 'gr', 'gramo', 'gramos'].includes(u)) return 'g';
  if (['m', 'metro', 'metros'].includes(u)) return 'm';
  if (['un', 'u', 'unidad', 'unidades'].includes(u)) return 'un';
  return u;
}
function unidadUsoDe(comp, ins) {
  if (comp.unidad_uso) return normUnidad(comp.unidad_uso);
  const ui = normUnidad(ins && ins.unidad);
  // Compatibilidad con recetas viejas (sin unidad_uso): kg con cantidad > 10 se interpretaba como gramos
  if (ui === 'kg' && comp.cantidad_usada > 10) return 'g';
  return ui;
}
function aUnidadInsumo(cant, uso, unidadInsumo) {
  const u = normUnidad(uso), i = normUnidad(unidadInsumo);
  if (u === i) return cant;
  const f = FACTORES_UNIDAD[`${u}>${i}`];
  return f === undefined ? cant : cant * f;
}
function cantidadEnUnidadInsumo(comp, ins) {
  return aUnidadInsumo(comp.cantidad_usada, unidadUsoDe(comp, ins), ins.unidad);
}
function redondear(n) { return Math.round(n * 1e6) / 1e6; }

// Lista de Rubros / Publicidades
const DICCIONARIO_RUBROS = {
  '1': { nombre: 'Comida', banner: '🥐 Panadería y Comidas - ¡Descuentos en Harinas e Insumos!' },
  '2': { nombre: 'Ropa', banner: '🧵 Hilos, Telas y Confecciones - Ofertas de Temporada' },
  '3': { nombre: 'Cuero', banner: '🥩 Cueros, Remaches y Herrajes - Proveedores Seleccionados' },
  '4': { nombre: 'Dulces', banner: '🍯 Frutas, Frascos y Azúcar - Promociones para Artesanos' },
  '5': { nombre: 'Carnes', banner: '🔪 Chacinados y Embutidos - Equipamiento Ferial' },
  '6': { nombre: 'Orfebrería', banner: '💎 Metales, Piedras y Herramientas de Precisión' }
};

// Control de navegación entre pantallas
function mostrarPantalla(id) {
  const ids = [
    'pantalla-bienvenida', 'pantalla-portada', 'pantalla-menu', 'pantalla-armar', 'pantalla-reportes-menu', 'pantalla-mas',
    'pantalla-venta', 'pantalla-producir', 'pantalla-comprar', 'pantalla-reporte',
    'pantalla-reporte-general', 'pantalla-consulta', 'pantalla-nuevo', 'pantalla-insumos',
    'pantalla-recetas', 'pantalla-calculadora-lote', 'pantalla-grilla', 'pantalla-backup', 'pantalla-borrar'
  ];

  ids.forEach(pId => {
    const el = document.getElementById(pId);
    if (el) el.classList.add('hidden');
  });

  const activo = document.getElementById(id);
  if (activo) activo.classList.remove('hidden');

  if (['pantalla-menu', 'pantalla-armar', 'pantalla-mas'].includes(id)) cargarMenu();
  if (id === 'pantalla-reporte') {
    document.getElementById('reporte-fecha').value = hoyLocal();
    cargarReporteVentas();
  }
  if (id === 'pantalla-reporte-general') actualizarReporteGeneral();
  if (id === 'pantalla-consulta') cargarConsultaStock();
  if (id === 'pantalla-recetas') cargarOpcionesRecetas();
  if (id === 'pantalla-grilla') inicializarGrilla();
  if (id === 'pantalla-comprar') cargarPantallaCompra();
  if (id === 'pantalla-producir') cargarPantallaProduccion();
  window.scrollTo(0, 0);
}

// Validación de primer inicio y verificación de publicidad
document.addEventListener("DOMContentLoaded", async () => {
  await CargarPublicidadesLocales();
  
  const registrado = await db.configuracion.get('usuario_registrado');
  if (!registrado) {
    mostrarPantalla('pantalla-bienvenida');
  } else {
    mostrarPantalla('pantalla-portada');
  }

  if (navigator.onLine) {
    await SincronizarPublicidades();
  }
});

// Guardar los datos del registro inicial obligatorio
async function guardarRegistroInicial() {
  const nombre = document.getElementById('reg-nombre').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const whatsapp = document.getElementById('reg-whatsapp').value.trim();
  const rubro = document.getElementById('reg-rubro').value;
  const acepta = document.getElementById('reg-acepta').checked;

  if (!nombre || !email || !whatsapp || !rubro) {
    return alert("Por favor complete su nombre, correo, WhatsApp y seleccione un rubro.");
  }
  if (!acepta) {
    return alert("Debe aceptar los términos y condiciones para continuar.");
  }

  await db.configuracion.put({ clave: 'usuario_registrado', valor: 'true' });
  await db.configuracion.put({ clave: 'perfil_nombre', valor: nombre });
  await db.configuracion.put({ clave: 'perfil_email', valor: email });
  await db.configuracion.put({ clave: 'perfil_whatsapp', valor: whatsapp });
  await db.configuracion.put({ clave: 'rubro_publicidad', valor: rubro });

  alert("¡Registro exitoso! Bienvenido a la comunidad ferial.");
  mostrarPantalla('pantalla-portada');
}

// Lógica de Menú y Modo (Productor/Revendedor)
async function obtenerRubro() {
  const conf = await db.configuracion.get('rubro');
  return conf ? conf.valor : 'productor';
}

async function cambiarRubro() {
  const actual = await obtenerRubro();
  const nuevo = actual === 'revendedor' ? 'productor' : 'revendedor';
  await db.configuracion.put({ clave: 'rubro', valor: nuevo });
  cargarMenu();
}

async function cargarMenu() {
  const rubro = await obtenerRubro();   // 'productor' o 'revendedor'
  const esProductor = rubro === 'productor';
  const mostrar = (id, ver) => {
    const el = document.getElementById(id);
    if (el) el.classList[ver ? 'remove' : 'add']('hidden');
  };

  mostrar('btn-menu-producir', esProductor);
  mostrar('btn-menu-comprar', esProductor);
  mostrar('seccion-pasos-productor', esProductor);
  mostrar('seccion-calculadora-extra', esProductor);
  mostrar('seccion-grilla-revendedor', !esProductor);

  const num = document.getElementById('num-paso-producto');
  if (num) num.innerText = esProductor ? '3️⃣' : '1️⃣';

  const btnModo = document.getElementById('btn-cambiar-rubro');
  if (btnModo) {
    btnModo.innerHTML = esProductor
      ? '<span class="ico">🔄</span><span>SOY PRODUCTOR<small>Fabrico lo que vendo · tocá para cambiar a revendedor</small></span>'
      : '<span class="ico">🔄</span><span>SOY REVENDEDOR<small>Vendo lo que compro · tocá para cambiar a productor</small></span>';
  }

  // Ayuda de primer uso: solo aparece mientras no haya ningún producto cargado
  mostrar('menu-ayuda', (await db.productos.count()) === 0);
}

async function validarYIrARecetas() {
  const cantidadInsumos = await db.insumos.count();
  if (cantidadInsumos === 0) {
    alert("⚠️ ¡Atención!\n\nPrimero debes cargar tus insumos en el PASO 1 antes de armar la receta.");
    mostrarPantalla('pantalla-insumos');
  } else {
    mostrarPantalla('pantalla-recetas');
  }
}

async function abrirModalPublicidad() {
  document.getElementById('modal-publicidad').classList.remove('hidden');
}

function cerrarModalPublicidad() {
  document.getElementById('modal-publicidad').classList.add('hidden');
}

async function seleccionarRubroPublicidad() {
  const cod = document.getElementById('select-rubro-pub').value;
  if (!cod) return alert("Seleccione un rubro.");

  await db.configuracion.put({ clave: 'rubro_publicidad', valor: cod });

  const rubroInfo = DICCIONARIO_RUBROS[cod];
  const mensaje = `Hola, acabo de configurar mi app de feria con el Rubro: Código ${cod} (${rubroInfo.nombre}). Solicitó el banner publicitario correspondiente.`;
  
  window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(mensaje)}`, '_blank');
  cerrarModalPublicidad();
  if (navigator.onLine) {
    SincronizarPublicidades();
  }
}

async function buscarVentaPredictiva(texto) {
  const cont = document.getElementById('venta-sugerencias');
  cont.innerHTML = '';
  if (!texto.trim()) return;

  const prods = await db.productos
    .filter(p => p.detalle.toLowerCase().includes(texto.toLowerCase()) || p.codigo.toLowerCase().includes(texto.toLowerCase()))
    .limit(3)
    .toArray();

  prods.forEach(p => {
    const b = document.createElement('button');
    b.className = 'btn btn-blue';
    b.style.fontSize = '12px';
    b.innerText = `${p.detalle} ($${p.precio_ref.toFixed(2)}) - Stock: ${p.stock}`;
    b.onclick = () => seleccionarProductoVenta(p);
    cont.appendChild(b);
  });
}

function seleccionarProductoVenta(p) {
  productoSeleccionadoVenta = p;
  document.getElementById('venta-sugerencias').innerHTML = '';
  document.getElementById('venta-buscar').value = p.detalle;
  document.getElementById('venta-detalle').innerText = `Detalle: ${p.detalle}`;
  document.getElementById('venta-costo').innerText = `Costo Unit: $${p.precio_costo.toFixed(2)}`;
  document.getElementById('venta-ref').innerText = `Precio Ref: $${p.precio_ref.toFixed(2)} | Stock: ${p.stock}`;
  document.getElementById('venta-precio').value = p.precio_ref;
}

// CONFIRMAR VENTA Y DESCONTAR INSUMOS AUTOMÁTICAMENTE
async function validarYConfirmarVenta() {
  if (!productoSeleccionadoVenta) return alert("Seleccione un producto primero.");

  const cant = Number(document.getElementById('venta-cant').value);
  const pVenta = parseFloat(document.getElementById('venta-precio').value);
  if (!Number.isInteger(cant) || cant <= 0) return alert("La cantidad tiene que ser un número entero mayor que 0.");
  if (!Number.isFinite(pVenta) || pVenta < 0) return alert("Ingresá un precio de venta válido.");

  const codigo = productoSeleccionadoVenta.codigo;
  const prodActual = await db.productos.get(codigo);
  if (!prodActual) return alert("Ese producto ya no existe.");

  const stockNuevo = prodActual.stock - cant;
  if (stockNuevo < 0) {
    if (!confirm(`⚠️ ¡Stock insuficiente!\nStock actual: ${prodActual.stock}\nQuedará en: ${stockNuevo}\n\nSi ya fabricaste más, primero anotalo en PRODUCIR.\n¿Querés vender de todos modos?`)) {
      return;
    }
  }

  // Todo o nada: si algo falla, no se modifica ni el stock ni las ventas
  try {
    await db.transaction('rw', db.productos, db.ventas, async () => {
      const prod = await db.productos.get(codigo);
      await db.ventas.add({
        fecha: fechaLocalISO(),
        codigo: prod.codigo,
        detalle: prod.detalle,
        costo_unit: prod.precio_costo,
        precio_venta: pVenta,
        cantidad: cant,
        ganancia: (pVenta - prod.precio_costo) * cant
      });
      await db.productos.update(codigo, { stock: prod.stock - cant });
    });
  } catch (err) {
    return alert("No se pudo registrar la venta. No se modificó nada.\n" + err.message);
  }

  alert("✅ Venta registrada.");

  document.getElementById('venta-buscar').value = '';
  document.getElementById('venta-precio').value = '';
  document.getElementById('venta-cant').value = '1';
  document.getElementById('venta-sugerencias').innerHTML = '';
  productoSeleccionadoVenta = null;
}

async function cargarReporteVentas() {
  const fechaSel = document.getElementById('reporte-fecha').value;
  const ventas = await db.ventas.toArray();
  const filtradas = ventas.filter(v => normalizarFecha(v.fecha).startsWith(fechaSel));

  let totalVendido = 0;
  let totalGanancia = 0;
  let html = '<table><tr><th>Hora</th><th>Detalle</th><th>Cant</th><th>Subtotal</th><th>Ganancia</th></tr>';

  filtradas.forEach((v, i) => {
    const subtotal = v.cantidad * v.precio_venta;
    totalVendido += subtotal;
    totalGanancia += v.ganancia;
    html += `<tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
      <td>${normalizarFecha(v.fecha).substring(11, 16)}</td><td>${v.detalle}</td><td>${v.cantidad}</td><td>$${subtotal.toFixed(2)}</td><td>$${v.ganancia.toFixed(2)}</td>
    </tr>`;
  });

  document.getElementById('reporte-lista').innerHTML = html + '</table>';
  document.getElementById('reporte-totales').innerText = `Vendido: $${totalVendido.toFixed(2)} | Ganancia: $${totalGanancia.toFixed(2)}`;
}

function compartirReporteWhatsApp() {
  const fechaSel = document.getElementById('reporte-fecha').value;
  const texto = document.getElementById('reporte-totales').innerText;
  window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(`*REPORTE DE VENTAS - ${fechaSel}*\n${texto}`)}`, '_blank');
}

async function actualizarReporteGeneral() {
  const periodo = document.getElementById('reporte-periodo').value;
  const ventas = await db.ventas.toArray();
  const ahora = new Date();
  let etiquetas = [];
  let totales = [];

  if (periodo === 'dia') {
    const hoyStr = hoyLocal(ahora);
    const ventasHoy = ventas.filter(v => normalizarFecha(v.fecha).startsWith(hoyStr));
    const horasMap = {};
    for (let h = 8; h <= 22; h += 2) {
      const horaLabel = `${h.toString().padStart(2, '0')}:00`;
      horasMap[horaLabel] = 0;
    }

    ventasHoy.forEach(v => {
      const hora = parseInt(normalizarFecha(v.fecha).substring(11, 13), 10);
      const bloque = `${(Math.floor(hora / 2) * 2).toString().padStart(2, '0')}:00`;
      if (horasMap[bloque] !== undefined) {
        horasMap[bloque] += (v.cantidad * v.precio_venta);
      }
    });

    etiquetas = Object.keys(horasMap);
    totales = Object.values(horasMap);

  } else if (periodo === 'semana') {
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(ahora.getDate() - i);
      const fechaStr = hoyLocal(d);
      const diaNombre = d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric' });
      
      const totalDia = ventas
        .filter(v => normalizarFecha(v.fecha).startsWith(fechaStr))
        .reduce((sum, v) => sum + (v.cantidad * v.precio_venta), 0);

      etiquetas.push(diaNombre);
      totales.push(totalDia);
    }
  }

  const ctx = document.getElementById('graficoVentas').getContext('2d');
  if (chartVentasInstancia) chartVentasInstancia.destroy();

  chartVentasInstancia = new Chart(ctx, {
    type: 'line',
    data: {
      labels: etiquetas,
      datasets: [{
        label: 'Ventas ($)',
        data: totales,
        borderColor: '#00b359',
        backgroundColor: 'rgba(0, 179, 89, 0.2)',
        fill: true,
        tension: 0.3
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#ccc' }, grid: { color: '#333' } },
        y: { ticks: { color: '#ccc' }, grid: { color: '#333' } }
      }
    }
  });

  await cargarStockInsumosReporte();
}

async function cargarStockInsumosReporte() {
  const insumos = await db.insumos.toArray();
  const cont = document.getElementById('reporte-insumos-stock');
  if (!cont) return;

  if (insumos.length === 0) {
    cont.innerHTML = '<div style="color:#aaa; font-size:12px;">No hay insumos registrados.</div>';
    return;
  }

  let html = '<table><tr><th>Insumo</th><th>Stock</th><th>Unidad</th></tr>';
  insumos.forEach((ins, i) => {
    const colorStock = ins.stock <= 5 ? '#ff5252' : '#00e676';
    html += `<tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
      <td>${ins.nombre}</td>
      <td style="color:${colorStock}; font-weight:bold;">${ins.stock}</td>
      <td>${ins.unidad}</td>
    </tr>`;
  });
  cont.innerHTML = html + '</table>';
}

async function buscarProductoFicha(texto) {
  const cont = document.getElementById('reporte-sugerencias-prod');
  if (!cont) return;
  cont.innerHTML = '';

  if (!texto.trim()) return;

  const prods = await db.productos
    .filter(p => p.detalle.toLowerCase().includes(texto.toLowerCase()) || p.codigo.toLowerCase().includes(texto.toLowerCase()))
    .limit(4)
    .toArray();

  prods.forEach(p => {
    const b = document.createElement('button');
    b.className = 'btn btn-blue';
    b.style.fontSize = '12px';
    b.style.margin = '2px 0';
    b.innerText = `${p.detalle} (${p.codigo})`;
    b.onclick = () => mostrarFichaProducto(p);
    cont.appendChild(b);
  });
}

async function mostrarFichaProducto(prod) {
  document.getElementById('reporte-sugerencias-prod').innerHTML = '';
  document.getElementById('reporte-buscar-prod').value = prod.detalle;

  const imgEl = document.getElementById('ficha-foto');
  if (prod.foto_path) {
    imgEl.src = prod.foto_path;
    imgEl.style.display = 'block';
  } else {
    imgEl.style.display = 'none';
  }

  document.getElementById('ficha-nombre').innerText = `${prod.detalle} [${prod.codigo}]`;
  document.getElementById('ficha-precios').innerText = `Costo: $${prod.precio_costo.toFixed(2)} | P. Ref: $${prod.precio_ref.toFixed(2)} | Stock: ${prod.stock}`;

  const componentes = await db.recetas.where('codigo_prod').equals(prod.codigo).toArray();
  const contIng = document.getElementById('ficha-ingredientes');

  if (componentes.length === 0) {
    contIng.innerHTML = '<div style="color:#aaa; font-size:12px;">Sin ingredientes o materiales vinculados.</div>';
  } else {
    let html = '<h6 style="margin:5px 0; text-align:left;">Materiales / Ingredientes:</h6><ul>';
    for (let c of componentes) {
      const ins = await db.insumos.get(c.id_insumo);
      const nombre = ins ? ins.nombre : 'Insumo #' + c.id_insumo;
      const unidad = ins ? unidadUsoDe(c, ins) : '';
      html += `<li>${nombre}: <b>${c.cantidad_usada} ${unidad}</b></li>`;
    }
    contIng.innerHTML = html + '</ul>';
  }

  document.getElementById('reporte-ficha-detalle').classList.remove('hidden');
}

// CONSULTA DE CATÁLOGO Y STOCK (TARJETAS VISUALES)
async function cargarConsultaStock(tipo) {
  if (tipo) filtroConsultaActual = tipo;
  const filtroTxt = document.getElementById('consulta-filtro').value.toLowerCase();
  
  let prods = await db.productos.toArray();
  prods = prods.filter(p => {
    const coincideTxt = p.detalle.toLowerCase().includes(filtroTxt) || p.codigo.toLowerCase().includes(filtroTxt);
    const coincideTipo = filtroConsultaActual === 'todos' || p.tipo === filtroConsultaActual;
    return coincideTxt && coincideTipo;
  });

  const contenedor = document.getElementById('consulta-tarjetas-container');
  if (!contenedor) return;

  if (prods.length === 0) {
    contenedor.innerHTML = '<div class="card" style="text-align:center; color:#aaa;">No se encontraron productos.</div>';
    return;
  }

  let html = '';

  for (let p of prods) {
    const componentes = await db.recetas.where('codigo_prod').equals(p.codigo).toArray();
    let listaIngredientesTxt = 'Sin insumos vinculados';
    
    if (componentes.length > 0) {
      let partes = [];
      for (let c of componentes) {
        const ins = await db.insumos.get(c.id_insumo);
        const nombreIns = ins ? ins.nombre : 'Insumo';
        const unidadIns = ins ? unidadUsoDe(c, ins) : '';
        partes.push(`${c.cantidad_usada} ${unidadIns} de ${nombreIns}`);
      }
      listaIngredientesTxt = partes.join(' • ');
    }

    const fotoHtml = p.foto_path 
      ? `<img src="${p.foto_path}" style="width:70px; height:70px; object-fit:cover; border-radius:6px; border:1px solid #444; flex-shrink:0;">`
      : `<div style="width:70px; height:70px; background:#222; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:10px; color:#777; flex-shrink:0;">Sin Foto</div>`;

    html += `
      <div class="card" style="margin-bottom: 10px; border-left: 4px solid #00b359;">
        <div style="display:flex; gap:10px; align-items:center;">
          ${fotoHtml}
          <div style="flex:1; overflow:hidden;">
            <h4 style="margin:0 0 3px 0; font-size:14px; color:#00d9ff; text-align:left;">${p.detalle}</h4>
            <div style="font-size:11px; color:#aaa; margin-bottom:4px;">Cód: <b>${p.codigo}</b> | Stock: <b style="color:#ffb74d;">${p.stock}</b></div>
            
            <div style="display:flex; gap:8px; font-size:12px; margin-bottom:4px; flex-wrap:wrap;">
              <span style="background:#222; padding:2px 6px; border-radius:4px; border:1px solid #444;">Costo: <b>$${p.precio_costo.toFixed(2)}</b></span>
              <span style="background:#112a1a; padding:2px 6px; border-radius:4px; border:1px solid #00b359; color:#00e676;">Precio Ref: <b>$${p.precio_ref.toFixed(2)}</b></span>
            </div>
          </div>
        </div>

        <div style="font-size:11px; color:#ccc; background:#1a1a1a; padding:6px; border-radius:4px; margin-top:8px; text-align:left;">
          📜 <b>Ingredientes / Materiales:</b> ${listaIngredientesTxt}
        </div>

        <button class="btn btn-green" style="margin-top:8px; padding:6px; font-size:12px;" onclick="prepararVentaDirectaDesdeCatalogo('${p.codigo}')">
          💰 Registrar Venta de este Producto
        </button>
      </div>
    `;
  }

  contenedor.innerHTML = html;
}

async function prepararVentaDirectaDesdeCatalogo(codigoProd) {
  const p = await db.productos.get(codigoProd);
  if (!p) return;
  
  mostrarPantalla('pantalla-venta');
  seleccionarProductoVenta(p);
}

// COMPRESIÓN Y PROCESAMIENTO DE FOTOS
function procesarYComprimirFoto(event) {
  const archivo = event.target.files[0];
  if (!archivo) return;

  const lector = new FileReader();
  lector.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      const maxDim = 300;
      let ancho = img.width;
      let alto = img.height;

      if (ancho > alto) {
        if (ancho > maxDim) {
          alto = Math.round((alto * maxDim) / ancho);
          ancho = maxDim;
        }
      } else {
        if (alto > maxDim) {
          ancho = Math.round((ancho * maxDim) / alto);
          alto = maxDim;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = ancho;
      canvas.height = alto;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, ancho, alto);

      const fotoReducidaBase64 = canvas.toDataURL('image/jpeg', 0.7);

      document.getElementById('prod-foto-base64').value = fotoReducidaBase64;
      document.getElementById('prod-foto-preview').src = fotoReducidaBase64;
      document.getElementById('prod-preview-container').style.display = 'block';
    };
    img.src = e.target.result;
  };
  lector.readAsDataURL(archivo);
}

function limpiarFotoFormulario() {
  document.getElementById('prod-foto-base64').value = '';
  document.getElementById('prod-foto-preview').src = '';
  document.getElementById('prod-preview-container').style.display = 'none';
  document.getElementById('prod-input-foto').value = '';
}

async function buscarProductoParaEditar() {
  const cod = document.getElementById('prod-codigo').value.trim();
  if (!cod) return alert("Ingrese un código para buscar.");

  const p = await db.productos.get(cod);
  if (p) {
    document.getElementById('prod-nombre').value = p.detalle;
    document.getElementById('prod-costo').value = p.precio_costo;
    document.getElementById('prod-ref').value = p.precio_ref;
    document.getElementById('prod-stock').value = p.stock;
    document.getElementById('prod-tipo').value = p.tipo || 'comestible';
    
    if (p.foto_path) {
      document.getElementById('prod-foto-base64').value = p.foto_path;
      document.getElementById('prod-foto-preview').src = p.foto_path;
      document.getElementById('prod-preview-container').style.display = 'block';
    } else {
      limpiarFotoFormulario();
    }

    document.getElementById('prod-estado').innerText = "Producto cargado.";
  } else {
    limpiarFotoFormulario();
    document.getElementById('prod-estado').innerText = "Nuevo producto.";
  }

  await importarDesdeEscandallo(false);
}

async function importarDesdeEscandallo(mostrarAlerta = true) {
  const cod = document.getElementById('prod-codigo').value.trim();
  if (!cod) {
    if (mostrarAlerta) alert("Ingrese un código de producto.");
    return;
  }

  const componentes = await db.recetas.where('codigo_prod').equals(cod).toArray();
  if (componentes.length === 0) {
    if (mostrarAlerta) alert("No hay una receta vinculada a este código.");
    return;
  }

  let costoCalculado = 0;
  for (let c of componentes) {
    const ins = await db.insumos.get(c.id_insumo);
    if (ins) {
      costoCalculado += ins.costo_unitario * cantidadEnUnidadInsumo(c, ins);
    }
  }

  document.getElementById('prod-costo').value = costoCalculado.toFixed(2);
  const margen = 2.0; 
  const precioRefSugerido = costoCalculado * margen;
  document.getElementById('prod-ref').value = precioRefSugerido.toFixed(2);

  document.getElementById('prod-estado').innerText = `Valores sincronizados desde la Receta (Costo: $${costoCalculado.toFixed(2)})`;
  if (mostrarAlerta) alert("Costo y Precio de Referencia importados con éxito desde la receta.");
}

async function guardarProducto() {
  const codigo = document.getElementById('prod-codigo').value.trim();
  const detalle = document.getElementById('prod-nombre').value.trim();
  if (!codigo || !detalle) return alert("Complete código y detalle.");

  await db.productos.put({
    codigo, detalle,
    precio_costo: parseFloat(document.getElementById('prod-costo').value || 0),
    precio_ref: parseFloat(document.getElementById('prod-ref').value || 0),
    stock: parseInt(document.getElementById('prod-stock').value || 0),
    tipo: document.getElementById('prod-tipo').value,
    foto_path: document.getElementById('prod-foto-base64').value
  });

  alert("Guardado correctamente.");
  document.getElementById('prod-codigo').value = '';
  document.getElementById('prod-nombre').value = '';
  limpiarFotoFormulario();
}

// GESTIÓN DE INSUMOS: EDICIÓN, LISTADO Y PRECIO PROMEDIO PONDERADO
async function toggleListadoInsumos() {
  const contenedor = document.getElementById('contenedor-lista-insumos');
  if (!contenedor.classList.contains('hidden')) {
    contenedor.classList.add('hidden');
    return;
  }

  const insumos = await db.insumos.toArray();
  if (insumos.length === 0) {
    contenedor.innerHTML = '<div class="card" style="color:#aaa; font-size:13px; text-align:center;">No hay insumos cargados todavía.</div>';
    contenedor.classList.remove('hidden');
    return;
  }

  let html = '<div class="card"><h4 style="margin:0 0 5px 0; font-size:13px; color:#00d9ff;">Insumos en Stock (Toca ✏️ para editar):</h4><table><tr><th>Insumo</th><th>Stock</th><th>Costo</th><th>Acción</th></tr>';
  insumos.forEach((ins, i) => {
    html += `<tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
      <td>${ins.nombre}</td>
      <td style="color:#00e676; font-weight:bold;">${ins.stock} ${ins.unidad}</td>
      <td>$${ins.costo_unitario.toFixed(2)} / ${ins.unidad}</td>
      <td><button class="btn btn-blue" style="padding:2px 6px; font-size:11px; margin:0;" onclick="cargarInsumoParaEditar(${ins.id})">✏️</button></td>
    </tr>`;
  });
  html += '</table></div>';
  contenedor.innerHTML = html;
  contenedor.classList.remove('hidden');
}

async function cargarOpcionesRecetas() {
  const insumos = await db.insumos.toArray();
  const sel = document.getElementById('receta-select-insumo');
  if (sel) {
    sel.innerHTML = '<option value="">-- Seleccionar Insumo --</option>' +
      insumos.map(i => `<option value="${i.id}">${i.nombre} (${i.unidad}) - $${i.costo_unitario.toFixed(2)}/${i.unidad}</option>`).join('');
  }
  await actualizarUnidadesReceta();
}

// Muestra solo las unidades compatibles con el insumo elegido (kg -> kg o g, litros -> litros o ml, etc.)
async function actualizarUnidadesReceta() {
  const selUnidad = document.getElementById('receta-unidad-uso');
  if (!selUnidad) return;
  const id = parseInt(document.getElementById('receta-select-insumo').value, 10);
  const ins = id ? await db.insumos.get(id) : null;
  const opciones = ins ? (UNIDADES_USO[normUnidad(ins.unidad)] || [ins.unidad]) : [];
  selUnidad.innerHTML = opciones.map(u => `<option value="${u}">${u}</option>`).join('');
}

async function buscarProductoParaReceta(texto) {
  const cont = document.getElementById('receta-sugerencias-prod');
  if (!cont) return;
  cont.innerHTML = '';

  if (!texto.trim()) return;

  const prods = await db.productos
    .filter(p => p.detalle.toLowerCase().includes(texto.toLowerCase()) || p.codigo.toLowerCase().includes(texto.toLowerCase()))
    .limit(4)
    .toArray();

  prods.forEach(p => {
    const b = document.createElement('button');
    b.className = 'btn btn-blue';
    b.style.fontSize = '12px';
    b.style.margin = '2px 0';
    b.innerText = `${p.detalle} (Cód: ${p.codigo})`;
    b.onclick = () => seleccionarProductoParaReceta(p);
    cont.appendChild(b);
  });
}

async function buscarProductoParaCalculadoraLote(texto) {
  const cont = document.getElementById('calc-sugerencias-prod');
  if (!cont) return;
  cont.innerHTML = '';

  if (!texto.trim()) return;

  const prods = await db.productos
    .filter(p => p.detalle.toLowerCase().includes(texto.toLowerCase()) || p.codigo.toLowerCase().includes(texto.toLowerCase()))
    .limit(4)
    .toArray();

  prods.forEach(p => {
    const b = document.createElement('button');
    b.className = 'btn btn-blue';
    b.style.fontSize = '12px';
    b.style.margin = '2px 0';
    b.innerText = `${p.detalle} (Cód: ${p.codigo})`;
    b.onclick = () => {
      document.getElementById('calc-sugerencias-prod').innerHTML = '';
      document.getElementById('calc-buscar-prod').value = p.detalle;
      document.getElementById('calc-cod-prod').value = p.codigo;
    };
    cont.appendChild(b);
  });
}

async function vincularIngrediente() {
  const codProd = document.getElementById('receta-cod-prod').value.trim();
  const idInsumo = parseInt(document.getElementById('receta-select-insumo').value, 10);
  const cantUsada = parseFloat(document.getElementById('receta-cant-usada').value || 0);
  const selUnidad = document.getElementById('receta-unidad-uso');

  if (!codProd || !idInsumo || !(cantUsada > 0)) return alert("Complete código de producto, insumo y cantidad.");

  const ins = await db.insumos.get(idInsumo);
  const unidadUso = (selUnidad && selUnidad.value) || (ins ? ins.unidad : 'un');

  await db.recetas.put({ codigo_prod: codProd, id_insumo: idInsumo, cantidad_usada: cantUsada, unidad_uso: unidadUso });
  alert("Insumo vinculado a la receta.");
  document.getElementById('receta-cant-usada').value = '';
  cargarDetalleRecetaRegistrada();
}

async function eliminarIngredienteReceta(codProd, idInsumo) {
  await db.recetas.where('[codigo_prod+id_insumo]').equals([codProd, idInsumo]).delete();
  cargarDetalleRecetaRegistrada();
}

async function calcularEscandallo() {
  const cod = document.getElementById('calc-cod-prod').value.trim() || document.getElementById('receta-cod-prod').value.trim();
  const lote = parseInt(document.getElementById('receta-lote').value || 1, 10);
  if (!cod) return alert("Ingrese un código de producto.");
  if (!(lote > 0)) return alert("La cantidad a fabricar tiene que ser mayor que 0.");

  const componentes = await db.recetas.where('codigo_prod').equals(cod).toArray();
  if (componentes.length === 0) return alert("No hay una receta o insumos asignados a este código.");

  let costoUnit = 0;
  ultimosFaltantesCompras = [];
  let htmlMateriales = '<h4>Materiales Necesarios para ' + lote + ' unidad(es):</h4><table><tr><th>Insumo</th><th>Requerido</th><th>Subtotal</th></tr>';

  for (let c of componentes) {
    const ins = await db.insumos.get(c.id_insumo);
    if (!ins) continue;

    const porUnidadEnInsumo = cantidadEnUnidadInsumo(c, ins);   // por 1 producto, en la unidad del insumo
    const requeridoUso = c.cantidad_usada * lote;                // para mostrar, en la unidad de la receta
    const requeridoInsumo = porUnidadEnInsumo * lote;            // para costo y stock, en la unidad del insumo
    costoUnit += ins.costo_unitario * porUnidadEnInsumo;

    htmlMateriales += `<tr>
        <td>${ins.nombre}</td>
        <td><b>${requeridoUso.toFixed(2)} ${unidadUsoDe(c, ins)}</b></td>
        <td>$${(ins.costo_unitario * requeridoInsumo).toFixed(2)}</td>
      </tr>`;

    if (ins.stock < requeridoInsumo) {
      ultimosFaltantesCompras.push({ nombre: ins.nombre, faltante: requeridoInsumo - ins.stock, unidad: ins.unidad });
    }
  }

  htmlMateriales += '</table>';
  const costoTotalLote = costoUnit * lote;

  document.getElementById('receta-resultado-tabla').innerHTML = htmlMateriales;
  document.getElementById('receta-resultado').innerText = `Costo Unitario: $${costoUnit.toFixed(2)} | Costo Lote (${lote} un): $${costoTotalLote.toFixed(2)}`;

  const prodExistente = await db.productos.get(cod);
  if (prodExistente) {
    await db.productos.update(cod, { precio_costo: costoUnit });
  }
}

// CALCULAR MÁXIMO PRODUCIBLE SEGÚN STOCK DE INSUMOS
async function calcularMaximoProducible() {
  const cod = document.getElementById('calc-cod-prod').value.trim() || document.getElementById('receta-cod-prod').value.trim();
  if (!cod) return alert("Seleccione un producto primero.");

  const componentes = await db.recetas.where('codigo_prod').equals(cod).toArray();
  if (componentes.length === 0) return alert("Este producto no tiene insumos vinculados en su receta.");

  let maximoPosible = Infinity;
  let insumoLimitante = "";
  let detalleAnalisis = "<h4>Análisis de Stock para Producción:</h4><ul>";

  for (let c of componentes) {
    const ins = await db.insumos.get(c.id_insumo);
    if (ins) {
      const porUnidad = cantidadEnUnidadInsumo(c, ins);   // en la unidad del insumo
      const unidadesConEsteInsumo = porUnidad > 0 ? Math.floor(redondear(ins.stock / porUnidad)) : Infinity;
      const alcanza = unidadesConEsteInsumo === Infinity ? 'sin límite' : unidadesConEsteInsumo;
      detalleAnalisis += `<li>${ins.nombre}: Tenés ${ins.stock} ${ins.unidad}. Alcanza para <b>${alcanza}</b> un.</li>`;

      if (unidadesConEsteInsumo < maximoPosible) {
        maximoPosible = unidadesConEsteInsumo;
        insumoLimitante = ins.nombre;
      }
    } else {
      maximoPosible = 0;
      detalleAnalisis += `<li style="color:#ff5252;">Falta registrar insumo ID ${c.id_insumo}</li>`;
    }
  }
  detalleAnalisis += "</ul>";

  const resultadoEl = document.getElementById('receta-resultado');
  if (maximoPosible === Infinity || maximoPosible <= 0) {
    resultadoEl.innerHTML = `<span style="color:#ff5252;">⚠️ No se puede fabricar ninguna unidad. Falta stock de: <b>${insumoLimitante || 'insumos'}</b>.</span>`;
  } else {
    resultadoEl.innerHTML = `<span style="color:#00e676; font-size:16px;">🎯 Con tu stock actual podés fabricar hasta <b>${maximoPosible} unidades</b>.<br><span style="font-size:12px; color:#ffb74d;">(El insumo que marca el límite es: ${insumoLimitante})</span></span>`;
  }

  const tablaEl = document.getElementById('receta-resultado-tabla');
  if (tablaEl) tablaEl.innerHTML = detalleAnalisis;
}

function compartirComprasWhatsApp() {
  if (ultimosFaltantesCompras.length === 0) return alert("No hay faltantes registrados para el lote calculado.");
  let txt = "*COMPRAS DE INSUMOS FALTANTES*\n\n";
  ultimosFaltantesCompras.forEach(f => {
    txt += `• ${f.nombre}: Faltan ${f.faltante.toFixed(2)} ${f.unidad}\n`;
  });
  window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(txt)}`, '_blank');
}

// GESTIÓN DE GRILLA Y BORRADO
function inicializarGrilla() {
  document.getElementById('contenedor-grilla').innerHTML = '';
  for(let i=0; i<4; i++) agregarFilaGrilla();
}

function agregarFilaGrilla() {
  const div = document.createElement('div');
  div.style.display = 'flex'; div.style.gap = '4px'; div.style.marginBottom = '4px';
  div.innerHTML = `
    <input type="text" placeholder="Cód" style="width:20%;">
    <input type="text" placeholder="Detalle" style="width:35%;">
    <input type="number" placeholder="Costo" style="width:15%;">
    <input type="number" placeholder="P.Ref" style="width:15%;">
    <button class="btn btn-green" style="width:15%; padding:5px; margin:5px 0;" onclick="altaFilaGrilla(this)">OK</button>
  `;
  document.getElementById('contenedor-grilla').appendChild(div);
}

async function altaFilaGrilla(btn) {
  const inputs = btn.parentElement.querySelectorAll('input');
  const codigo = inputs[0].value.trim();
  const detalle = inputs[1].value.trim();
  if (!codigo || !detalle) return alert("Complete código y detalle.");

  await db.productos.put({
    codigo, detalle,
    precio_costo: parseFloat(inputs[2].value || 0),
    precio_ref: parseFloat(inputs[3].value || 0),
    stock: 0, tipo: 'comestible', foto_path: ''
  });

  btn.disabled = true;
  btn.innerText = "✓";
}

async function ejecutarBorrado() {
  const cod = document.getElementById('borrar-codigo').value.trim();
  if (!cod) return alert("Ingrese un código.");
  await db.productos.delete(cod);
  await db.recetas.where('codigo_prod').equals(cod).delete();
  alert("Producto eliminado.");
  document.getElementById('borrar-codigo').value = '';
}

// EXPORTAR E IMPORTAR RESPALDOS
async function armarRespaldo(incluirConfiguracion) {
  const datos = {
    productos: await db.productos.toArray(),
    ventas: await db.ventas.toArray(),
    insumos: await db.insumos.toArray(),
    recetas: await db.recetas.toArray(),
    compras: await db.compras.toArray(),
    producciones: await db.producciones.toArray()
  };
  if (incluirConfiguracion) datos.configuracion = await db.configuracion.toArray();
  return datos;
}

function descargarArchivo(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function exportarArchivoRespaldo() {
  const datos = await armarRespaldo(true);
  const blob = new Blob([JSON.stringify(datos, null, 2)], { type: 'application/json' });
  descargarArchivo(blob, `Respaldo_Feria_${hoyLocal()}.json`);
  alert("¡Respaldo exportado con éxito a tu carpeta de Descargas!");
}

async function importarArchivoRespaldo(event) {
  const input = event.target;
  const archivo = input.files[0];
  if (!archivo) return;

  const lector = new FileReader();
  lector.onload = async function(e) {
    try {
      const datos = JSON.parse(e.target.result);
      const hayDatos = datos && typeof datos === 'object' &&
        ['productos', 'ventas', 'insumos', 'recetas'].some(k => Array.isArray(datos[k]));
      if (!hayDatos) throw new Error("El archivo no parece ser un respaldo de esta app.");

      if (!confirm("¿Querés importar este respaldo?")) return;
      const reemplazar = confirm(
        "¿Cómo querés importarlo?\n\n" +
        "ACEPTAR = REEMPLAZAR: borra los datos de este celular y deja solo los del archivo.\n\n" +
        "CANCELAR = COMBINAR: suma los datos del archivo a los que ya tenés (no pisa tus ventas)."
      );

      const resumen = reemplazar ? await restaurarRespaldoReemplazando(datos) : await restaurarRespaldoCombinando(datos);
      alert(resumen);
      mostrarPantalla('pantalla-menu');
    } catch (err) {
      alert("Error al leer el archivo de respaldo: " + err.message);
    } finally {
      input.value = '';
    }
  };
  lector.readAsText(archivo);
}

// REEMPLAZAR: las tablas que vienen en el archivo se vacían y se cargan tal cual (conserva los ids)
async function restaurarRespaldoReemplazando(datos) {
  const lista = k => Array.isArray(datos[k]) ? datos[k] : [];
  await db.transaction('rw', db.productos, db.ventas, db.insumos, db.recetas, db.compras, db.producciones, db.configuracion, async () => {
    for (const k of ['productos', 'ventas', 'insumos', 'recetas', 'compras', 'producciones']) {
      if (Array.isArray(datos[k])) {
        await db[k].clear();
        await db[k].bulkAdd(datos[k]);
      }
    }
    await db.configuracion.bulkPut(lista('configuracion'));
  });
  return `✅ Respaldo restaurado: ${lista('productos').length} productos, ${lista('insumos').length} insumos, ${lista('recetas').length} líneas de receta, ${lista('ventas').length} ventas, ${lista('compras').length} compras y ${lista('producciones').length} producciones.`;
}

// COMBINAR: los ids autoincrementales de otro celular pueden chocar con los de este,
// así que los insumos se unen por nombre y las ventas se agregan con id nuevo (sin duplicar).
async function restaurarRespaldoCombinando(datos) {
  const lista = k => Array.isArray(datos[k]) ? datos[k] : [];
  let insumosNuevos = 0, ventasNuevas = 0, comprasNuevas = 0, produccionesNuevas = 0;

  await db.transaction('rw', db.productos, db.ventas, db.insumos, db.recetas, db.compras, db.producciones, async () => {
    await db.productos.bulkPut(lista('productos'));

    const mapaInsumos = {};   // id en el archivo -> id en este celular
    for (const ins of lista('insumos')) {
      const nombre = (ins.nombre || '').toLowerCase();
      const existente = await db.insumos.filter(i => (i.nombre || '').toLowerCase() === nombre).first();
      if (existente) {
        mapaInsumos[ins.id] = existente.id;
      } else {
        const { id, ...resto } = ins;
        mapaInsumos[id] = await db.insumos.add(resto);
        insumosNuevos++;
      }
    }
    const idLocal = idArchivo => mapaInsumos[idArchivo] !== undefined ? mapaInsumos[idArchivo] : idArchivo;

    for (const r of lista('recetas')) {
      await db.recetas.put({ ...r, id_insumo: idLocal(r.id_insumo) });
    }

    const claveVenta = v => `${v.fecha}|${v.codigo}|${v.cantidad}|${v.precio_venta}`;
    const ventasConocidas = new Set((await db.ventas.toArray()).map(claveVenta));
    for (const v of lista('ventas')) {
      const k = claveVenta(v);
      if (ventasConocidas.has(k)) continue;
      const { id, ...resto } = v;
      await db.ventas.add(resto);
      ventasConocidas.add(k);
      ventasNuevas++;
    }

    const claveCompra = c => `${c.fecha}|${c.id_insumo}|${c.cantidad}|${c.total}`;
    const comprasConocidas = new Set((await db.compras.toArray()).map(claveCompra));
    for (const c of lista('compras')) {
      const nueva = { ...c, id_insumo: idLocal(c.id_insumo) };
      const k = claveCompra(nueva);
      if (comprasConocidas.has(k)) continue;
      delete nueva.id;
      await db.compras.add(nueva);
      comprasConocidas.add(k);
      comprasNuevas++;
    }

    const claveProd = p => `${p.fecha}|${JSON.stringify(p.items)}`;
    const produccionesConocidas = new Set((await db.producciones.toArray()).map(claveProd));
    for (const p of lista('producciones')) {
      const k = claveProd(p);
      if (produccionesConocidas.has(k)) continue;
      const { id, ...resto } = p;
      await db.producciones.add(resto);
      produccionesConocidas.add(k);
      produccionesNuevas++;
    }
  });

  return `✅ Respaldo combinado: ${lista('productos').length} productos procesados, ${insumosNuevos} insumos nuevos, ${ventasNuevas} ventas, ${comprasNuevas} compras y ${produccionesNuevas} producciones nuevas agregadas.`;
}

// Antes se metia todo el JSON (con fotos) en la URL de WhatsApp, que tiene un limite de largo y fallaba.
// Ahora se comparte como archivo; si el navegador no puede, se descarga para adjuntarlo a mano.
async function exportarRespaldoWhatsApp() {
  const datos = await armarRespaldo(false);   // sin perfil (correo/WhatsApp)
  const nombre = `Respaldo_Feria_${hoyLocal()}.json`;
  const archivo = new File([JSON.stringify(datos)], nombre, { type: 'application/json' });

  if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
    try {
      await navigator.share({ files: [archivo], title: 'Respaldo Feria' });
    } catch (err) {
      if (err.name !== 'AbortError') alert("No se pudo compartir el respaldo: " + err.message);
    }
    return;
  }

  descargarArchivo(archivo, nombre);
  alert("Tu navegador no permite compartir archivos directamente.\n\nEl respaldo se descargó: adjuntalo desde WhatsApp (clip 📎 → Documento).");
}

// PUBLICIDAD Y BANNER ROTATIVO
const URL_PUBLICIDADES_REMOTA = 'https://raw.githubusercontent.com/betazon/Feria-Gestion/main/publicidades.json';

let anunciosCargados = [];
let indiceAnuncioActual = 0;

window.addEventListener('online', SincronizarPublicidades);

async function CargarPublicidadesLocales() {
  const conf = await db.configuracion.get('anuncios_guardados');
  if (conf && conf.valor) {
    anunciosCargados = JSON.parse(conf.valor);
    IniciarRotacionBanner();
  }
}

async function SincronizarPublicidades() {
  try {
    const respuesta = await fetch(URL_PUBLICIDADES_REMOTA + '?t=' + new Date().getTime());
    if (respuesta.ok) {
      const datosRubros = await respuesta.json();
      
      const rubroConf = await db.configuracion.get('rubro_publicidad');
      const rubroCod = rubroConf ? rubroConf.valor : '1';
      
      if (datosRubros[rubroCod]) {
        anunciosCargados = datosRubros[rubroCod];
        await db.configuracion.put({ clave: 'anuncios_guardados', valor: JSON.stringify(anunciosCargados) });
        IniciarRotacionBanner();
      }
    }
  } catch (err) {
    console.log("Modo offline: Usando publicidad almacenada localmente.");
  }
}

function IniciarRotacionBanner() {
  if (anunciosCargados.length === 0) return;
  
  MostrarSiguienteAnuncio();
  setInterval(() => {
    MostrarSiguienteAnuncio();
  }, 8000);
}

function MostrarSiguienteAnuncio() {
  const anuncio = anunciosCargados[indiceAnuncioActual];
  const bannerEl = document.getElementById('banner-texto');
  
  if (bannerEl && anuncio) {
    bannerEl.innerText = `🏪 ${anuncio.negocio} | 🏷️ ${anuncio.oferta} | 📞 ${anuncio.contacto}`;
  }

  indiceAnuncioActual = (indiceAnuncioActual + 1) % anunciosCargados.length;
}
function seleccionarProductoParaReceta(p) {
  document.getElementById('receta-sugerencias-prod').innerHTML = '';
  document.getElementById('receta-buscar-prod').value = p.detalle;
  document.getElementById('receta-cod-prod').value = p.codigo;
  cargarDetalleRecetaRegistrada();
}

async function cargarDetalleRecetaRegistrada() {
  const codProd = document.getElementById('receta-cod-prod').value.trim();
  const cont = document.getElementById('receta-ingredientes-lista');
  const imgEl = document.getElementById('receta-foto-preview');
  const phEl = document.getElementById('receta-foto-placeholder');
  const tituloEl = document.getElementById('receta-prod-titulo');

  if (!cont) return;

  if (!codProd) {
    cont.innerHTML = '<span style="color:#aaa; font-size:11px;">Busque un producto para ver sus componentes.</span>';
    if (imgEl) imgEl.style.display = 'none';
    if (phEl) phEl.style.display = 'flex';
    if (tituloEl) tituloEl.innerText = 'Seleccione producto';
    return;
  }

  // Buscar datos del producto para actualizar foto y título
  const prod = await db.productos.get(codProd);
  if (prod) {
    if (tituloEl) tituloEl.innerText = prod.detalle;
    if (prod.foto_path) {
      if (imgEl) { imgEl.src = prod.foto_path; imgEl.style.display = 'block'; }
      if (phEl) phEl.style.display = 'none';
    } else {
      if (imgEl) imgEl.style.display = 'none';
      if (phEl) phEl.style.display = 'flex';
    }
  } else {
    if (tituloEl) tituloEl.innerText = `Cód: ${codProd}`;
    if (imgEl) imgEl.style.display = 'none';
    if (phEl) phEl.style.display = 'flex';
  }

  // Cargar componentes de la receta
  const componentes = await db.recetas.where('codigo_prod').equals(codProd).toArray();
  if (componentes.length === 0) {
    cont.innerHTML = '<div style="color:#aaa; font-size:11px;">Sin insumos cargados para este producto.</div>';
    return;
  }

  let html = '<table style="margin-top:0;"><tr><th>Insumo</th><th>Cant.</th><th></th></tr>';
  for (let c of componentes) {
    const ins = await db.insumos.get(c.id_insumo);
    const nombreInsumo = ins ? ins.nombre : 'Insumo #' + c.id_insumo;
    const unidad = ins ? unidadUsoDe(c, ins) : '';
    html += `<tr>
      <td style="font-size:11px;">${nombreInsumo}</td>
      <td style="font-size:11px; font-weight:bold; color:#00e676;">${c.cantidad_usada} ${unidad}</td>
      <td style="text-align:center;"><button class="btn btn-red" style="padding:1px 5px; font-size:10px; margin:0;" onclick="eliminarIngredienteReceta('${codProd}', ${c.id_insumo})">X</button></td>
    </tr>`;
  }
  cont.innerHTML = html + '</table>';
}
// Cargar datos del insumo para editar (Muestra el botón de eliminar)
async function cargarInsumoParaEditar(id) {
  const ins = await db.insumos.get(id);
  if (!ins) return;

  insumoEnEdicionId = ins.id;
  document.getElementById('insumo-nombre').value = ins.nombre;
  document.getElementById('insumo-unidad').value = ins.unidad.toLowerCase();
  document.getElementById('insumo-costo').value = ins.costo_unitario;
  document.getElementById('insumo-stock').value = ins.stock;

  const btnGuardar = document.getElementById('btn-guardar-insumo');
  if (btnGuardar) btnGuardar.innerText = "MODIFICAR INSUMO";

  const btnEliminar = document.getElementById('btn-eliminar-insumo');
  if (btnEliminar) btnEliminar.classList.remove('hidden'); // Mostrar botón de eliminar

  document.getElementById('contenedor-lista-insumos').classList.add('hidden');
}

// Eliminar un insumo de la base de datos
async function eliminarInsumoActual() {
  if (!insumoEnEdicionId) return;

  if (confirm("¿Estás seguro de eliminar este insumo definitivamente? Si está en una receta, podría afectar el cálculo.")) {
    await db.insumos.delete(insumoEnEdicionId);
    alert("🗑️ Insumo eliminado correctamente.");
    
    // Limpiar formulario y restablecer botones
    insumoEnEdicionId = null;
    document.getElementById('insumo-nombre').value = '';
    document.getElementById('insumo-unidad').value = '';
    document.getElementById('insumo-costo').value = '';
    document.getElementById('insumo-stock').value = '';
    
    document.getElementById('btn-guardar-insumo').innerText = "GUARDAR INSUMO";
    document.getElementById('btn-eliminar-insumo').classList.add('hidden');
    
    cargarOpcionesRecetas();
    toggleListadoInsumos();
  }
}

// Asegurarse de limpiar los campos al guardar un insumo nuevo o editado
async function guardarInsumo() {
  const nombre = document.getElementById('insumo-nombre').value.trim();
  const unidad = document.getElementById('insumo-unidad').value;
  const costoUnitarioNuevo = parseFloat(document.getElementById('insumo-costo').value || 0);
  const stockNuevo = parseFloat(document.getElementById('insumo-stock').value || 0);

  if (!nombre || !unidad) return alert("Complete el nombre y seleccione una unidad de medida.");

  if (insumoEnEdicionId) {
    await db.insumos.update(insumoEnEdicionId, { 
      nombre, 
      unidad, 
      costo_unitario: costoUnitarioNuevo, 
      stock: stockNuevo 
    });
    alert("✅ Insumo modificado correctamente.");
    
    insumoEnEdicionId = null;
    document.getElementById('btn-guardar-insumo').innerText = "GUARDAR INSUMO";
    document.getElementById('btn-eliminar-insumo').classList.add('hidden');
  } else {
    // Lógica de Precio Promedio Ponderado para insumos nuevos con igual nombre
    const insumosExistentes = await db.insumos
      .filter(i => i.nombre.toLowerCase() === nombre.toLowerCase())
      .toArray();

    if (insumosExistentes.length > 0) {
      const insumoExistente = insumosExistentes[0];
      const valorStockPrevio = insumoExistente.stock * insumoExistente.costo_unitario;
      const valorStockIngresado = stockNuevo * costoUnitarioNuevo;
      const stockTotalActualizado = insumoExistente.stock + stockNuevo;
      
      const nuevoCostoPromedioPonderado = stockTotalActualizado > 0 
        ? (valorStockPrevio + valorStockIngresado) / stockTotalActualizado 
        : costoUnitarioNuevo;

      await db.insumos.update(insumoExistente.id, {
        stock: stockTotalActualizado,
        costo_unitario: nuevoCostoPromedioPonderado,
        unidad: unidad
      });

      alert(`¡Insumo "${insumoExistente.nombre}" consolidado!\n\n` +
            `• Stock total actualizado: ${stockTotalActualizado} ${unidad}\n` +
            `• Nuevo Costo Promedio: $${nuevoCostoPromedioPonderado.toFixed(2)} / ${unidad}`);
    } else {
      await db.insumos.add({
        nombre,
        unidad,
        costo_unitario: costoUnitarioNuevo,
        stock: stockNuevo
      });

      alert("¡Insumo registrado correctamente!");
    }
  }

  document.getElementById('insumo-nombre').value = '';
  document.getElementById('insumo-unidad').value = '';
  document.getElementById('insumo-costo').value = '';
  document.getElementById('insumo-stock').value = '';
  cargarOpcionesRecetas();

  const contenedor = document.getElementById('contenedor-lista-insumos');
  if (!contenedor.classList.contains('hidden')) {
    contenedor.classList.add('hidden');
    toggleListadoInsumos();
  }
}

// =====================================================================
// AYUDAS PARA LAS PANTALLAS NUEVAS
// =====================================================================
function esc(t) {
  return String(t === undefined || t === null ? '' : t).replace(/[&<>"']/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function llenarSelect(sel, items, placeholder) {
  sel.innerHTML = '';
  if (placeholder) sel.appendChild(new Option(placeholder, ''));
  items.forEach(([valor, texto]) => sel.appendChild(new Option(texto, valor)));
}

function formatearFechaHora(f) {
  const n = normalizarFecha(f);
  return n ? `${n.substring(8, 10)}/${n.substring(5, 7)} ${n.substring(11, 16)}` : '';
}

// =====================================================================
// COMPRAR INSUMOS
// Suma lo comprado al stock y actualiza el costo (promedio entre lo que había y lo nuevo).
// =====================================================================
function calcularCompra(ins, cant, unidad, total) {
  const cantInsumo = aUnidadInsumo(cant, unidad, ins.unidad);    // lo comprado, en la unidad del insumo
  const stockNuevo = redondear(ins.stock + cantInsumo);
  const costoNuevo = stockNuevo > 0
    ? redondear((ins.stock * ins.costo_unitario + total) / stockNuevo)
    : ins.costo_unitario;
  return { cantInsumo, stockNuevo, costoNuevo };
}

async function cargarPantallaCompra() {
  const insumos = (await db.insumos.toArray()).sort((a, b) => a.nombre.localeCompare(b.nombre));
  llenarSelect(document.getElementById('compra-insumo'),
    insumos.map(i => [i.id, `${i.nombre} (${i.unidad})`]), '-- Elegí el insumo --');
  document.getElementById('compra-cant').value = '';
  document.getElementById('compra-total').value = '';
  await actualizarUnidadesCompra();
  await cargarHistorialCompras();
}

async function actualizarUnidadesCompra() {
  const id = parseInt(document.getElementById('compra-insumo').value, 10);
  const ins = id ? await db.insumos.get(id) : null;
  const opciones = ins ? (UNIDADES_USO[normUnidad(ins.unidad)] || [ins.unidad]) : [];
  llenarSelect(document.getElementById('compra-unidad'), opciones.map(u => [u, u]));
  await actualizarVistaCompra();
}

async function actualizarVistaCompra() {
  const vista = document.getElementById('compra-vista');
  if (!vista) return;
  const id = parseInt(document.getElementById('compra-insumo').value, 10);
  const cant = parseFloat(document.getElementById('compra-cant').value);
  const total = parseFloat(document.getElementById('compra-total').value);
  const ins = id ? await db.insumos.get(id) : null;

  if (!ins || !(cant > 0) || !(total >= 0)) {
    vista.innerText = 'Completá el insumo, la cantidad y lo que pagaste para ver cómo queda.';
    return;
  }
  const unidad = document.getElementById('compra-unidad').value || ins.unidad;
  const c = calcularCompra(ins, cant, unidad, total);
  vista.innerHTML = `Vas a tener <b>${c.stockNuevo} ${esc(ins.unidad)}</b> de ${esc(ins.nombre)}.<br>` +
                    `Costo actual: <b>$${c.costoNuevo.toFixed(2)}</b> por ${esc(ins.unidad)}`;
}

async function registrarCompra(id, cant, unidad, total) {
  let resultado;
  await db.transaction('rw', db.insumos, db.compras, async () => {
    const ins = await db.insumos.get(id);
    if (!ins) throw new Error("El insumo ya no existe.");
    const c = calcularCompra(ins, cant, unidad, total);
    await db.insumos.update(id, { stock: c.stockNuevo, costo_unitario: c.costoNuevo });
    await db.compras.add({
      fecha: fechaLocalISO(),
      id_insumo: id,
      nombre: ins.nombre,
      cantidad: cant,
      unidad: unidad,
      total: total,
      costo_unit: c.cantInsumo > 0 ? total / c.cantInsumo : 0
    });
    resultado = { nombre: ins.nombre, unidad: ins.unidad, stockNuevo: c.stockNuevo, costoNuevo: c.costoNuevo };
  });
  return resultado;
}

async function confirmarCompra() {
  const id = parseInt(document.getElementById('compra-insumo').value, 10);
  const cant = Number(document.getElementById('compra-cant').value);
  const totalTxt = document.getElementById('compra-total').value.trim();
  const total = Number(totalTxt);
  const unidad = document.getElementById('compra-unidad').value;

  if (!id) return alert("Elegí qué insumo compraste.");
  if (!(cant > 0)) return alert("Escribí cuánto compraste (un número mayor que 0).");
  if (totalTxt === '' || !Number.isFinite(total) || total < 0) return alert("Escribí cuánto pagaste en total.");

  let r;
  try {
    r = await registrarCompra(id, cant, unidad, total);
  } catch (err) {
    return alert("No se pudo registrar la compra. No se modificó nada.\n" + err.message);
  }

  alert(`✅ Compra registrada.\n\nAhora tenés ${r.stockNuevo} ${r.unidad} de ${r.nombre}.\nCosto actual: $${r.costoNuevo.toFixed(2)} por ${r.unidad}.`);
  await cargarPantallaCompra();
}

async function cargarHistorialCompras() {
  const cont = document.getElementById('compra-historial');
  if (!cont) return;
  const compras = (await db.compras.toArray()).sort((a, b) => b.id - a.id);
  if (compras.length === 0) { cont.innerHTML = ''; return; }

  const mes = hoyLocal().substring(0, 7);
  const gastoMes = compras
    .filter(c => normalizarFecha(c.fecha).startsWith(mes))
    .reduce((suma, c) => suma + (c.total || 0), 0);

  let html = `<div class="card" style="margin-top:12px;">
    <h4 style="margin:0 0 6px 0;">Mis últimas compras</h4>
    <div style="text-align:center; color:#ffb74d; font-weight:bold; margin-bottom:6px;">Gastaste este mes: $${gastoMes.toFixed(2)}</div>
    <table><tr><th>Fecha</th><th>Insumo</th><th>Cantidad</th><th>Pagué</th></tr>`;
  compras.slice(0, 10).forEach((c, i) => {
    html += `<tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
      <td>${formatearFechaHora(c.fecha)}</td><td>${esc(c.nombre)}</td>
      <td>${esc(c.cantidad)} ${esc(c.unidad)}</td><td>$${(c.total || 0).toFixed(2)}</td></tr>`;
  });
  cont.innerHTML = html + '</table></div>';
}

// =====================================================================
// PRODUCIR
// Se anota cuánto se fabricó de cada producto: se suma al stock del producto
// y se descuentan de una vez todos los insumos de las recetas.
// =====================================================================
function crearFilaProduccion(p, tieneReceta) {
  const fila = document.createElement('div');
  fila.className = 'card fila-produccion';
  fila.dataset.codigo = p.codigo;
  fila.dataset.titulo = p.detalle;

  const titulo = document.createElement('div');
  titulo.style.cssText = 'font-size:17px; font-weight:bold; color:#00d9ff; margin-bottom:2px;';
  titulo.textContent = p.detalle;

  const sub = document.createElement('div');
  sub.style.cssText = 'font-size:13px; color:#aaa; margin-bottom:8px;';
  sub.textContent = `Tenés ${p.stock} en stock` + (tieneReceta ? '' : ' · sin receta: solo suma stock');

  const control = document.createElement('div');
  control.className = 'stepper';

  const menos = document.createElement('button');
  menos.type = 'button';
  menos.className = 'btn btn-gray';
  menos.textContent = '−';

  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = '1';
  input.placeholder = '0';
  input.className = 'inp-produccion';
  input.setAttribute('inputmode', 'numeric');

  const mas = document.createElement('button');
  mas.type = 'button';
  mas.className = 'btn btn-green';
  mas.textContent = '+';

  const ajustar = d => {
    const n = Math.max(0, (parseInt(input.value, 10) || 0) + d);
    input.value = n === 0 ? '' : String(n);
  };
  menos.addEventListener('click', () => ajustar(-1));
  mas.addEventListener('click', () => ajustar(1));

  control.appendChild(menos);
  control.appendChild(input);
  control.appendChild(mas);
  fila.appendChild(titulo);
  fila.appendChild(sub);
  fila.appendChild(control);
  return fila;
}

async function cargarPantallaProduccion() {
  const cont = document.getElementById('producir-lista');
  cont.innerHTML = '';
  const filtro = document.getElementById('producir-filtro');
  if (filtro) filtro.value = '';

  const prods = (await db.productos.toArray()).sort((a, b) => a.detalle.localeCompare(b.detalle));
  if (prods.length === 0) {
    cont.innerHTML = '<div class="card" style="text-align:center; color:#aaa;">Todavía no cargaste productos.<br>Entrá a <b>MIS PRODUCTOS Y RECETAS</b> para empezar.</div>';
  } else {
    const conReceta = new Set((await db.recetas.toArray()).map(r => r.codigo_prod));
    prods.forEach(p => cont.appendChild(crearFilaProduccion(p, conReceta.has(p.codigo))));
  }
  await cargarHistorialProduccion();
}

function filtrarListaProduccion() {
  const texto = document.getElementById('producir-filtro').value.trim().toLowerCase();
  document.getElementById('producir-lista').querySelectorAll('.fila-produccion').forEach(f => {
    f.style.display = (f.dataset.titulo || '').toLowerCase().includes(texto) ? '' : 'none';
  });
}

// Cuánto de cada insumo hace falta para lo que se quiere producir (en la unidad de cada insumo)
async function calcularNecesidadInsumos(items) {
  const necesidad = {};   // id_insumo -> cantidad necesaria
  for (const it of items) {
    const componentes = await db.recetas.where('codigo_prod').equals(it.codigo).toArray();
    for (const c of componentes) {
      const ins = await db.insumos.get(c.id_insumo);
      if (!ins) continue;
      necesidad[ins.id] = (necesidad[ins.id] || 0) + cantidadEnUnidadInsumo(c, ins) * it.cantidad;
    }
  }
  const faltantes = [];
  for (const id of Object.keys(necesidad)) {
    const ins = await db.insumos.get(Number(id));
    if (ins.stock < necesidad[id] - 1e-9) {
      faltantes.push(`• ${ins.nombre}: necesitás ${redondear(necesidad[id])} ${ins.unidad} y tenés ${ins.stock}`);
    }
  }
  return { necesidad, faltantes };
}

async function registrarProduccion(items, necesidad) {
  let resumen = '';
  await db.transaction('rw', db.productos, db.insumos, db.producciones, async () => {
    for (const id of Object.keys(necesidad)) {
      const ins = await db.insumos.get(Number(id));
      if (ins) await db.insumos.update(ins.id, { stock: Math.max(0, redondear(ins.stock - necesidad[id])) });
    }
    const hechos = [];
    for (const it of items) {
      const p = await db.productos.get(it.codigo);
      if (!p) continue;
      await db.productos.update(it.codigo, { stock: p.stock + it.cantidad });
      hechos.push({ codigo: p.codigo, detalle: p.detalle, cantidad: it.cantidad });
    }
    await db.producciones.add({ fecha: fechaLocalISO(), items: hechos });
    resumen = hechos.map(h => `${h.cantidad} ${h.detalle}`).join(', ');
  });
  return resumen;
}

async function confirmarProduccion() {
  const filas = document.getElementById('producir-lista').querySelectorAll('.fila-produccion');
  const items = [];
  for (const fila of filas) {
    const txt = fila.querySelector('.inp-produccion').value.trim();
    if (txt === '') continue;
    const n = Number(txt);
    if (!Number.isInteger(n) || n < 0) {
      return alert(`Revisá la cantidad de "${fila.dataset.titulo}": tiene que ser un número entero.`);
    }
    if (n > 0) items.push({ codigo: fila.dataset.codigo, cantidad: n });
  }
  if (items.length === 0) return alert("Anotá cuántos fabricaste de al menos un producto.");

  const { necesidad, faltantes } = await calcularNecesidadInsumos(items);
  if (faltantes.length > 0) {
    const seguir = confirm(`⚠️ Te faltan insumos:\n\n${faltantes.join('\n')}\n\n¿Querés anotar la producción igual? (esos insumos quedarán en 0)`);
    if (!seguir) return;
  }

  let resumen;
  try {
    resumen = await registrarProduccion(items, necesidad);
  } catch (err) {
    return alert("No se pudo registrar la producción. No se modificó nada.\n" + err.message);
  }

  const descontoInsumos = Object.keys(necesidad).length > 0;
  alert(`✅ Producción registrada:\n${resumen}\n\nSe sumó a tu stock${descontoInsumos ? ' y se descontaron los insumos de las recetas' : ''}.`);
  await cargarPantallaProduccion();
}

async function cargarHistorialProduccion() {
  const cont = document.getElementById('producir-historial');
  if (!cont) return;
  const prods = (await db.producciones.toArray()).sort((a, b) => b.id - a.id).slice(0, 5);
  if (prods.length === 0) { cont.innerHTML = ''; return; }

  let html = '<div class="card" style="margin-top:12px;"><h4 style="margin:0 0 6px 0;">Mis últimas producciones</h4>';
  prods.forEach(p => {
    const detalle = (p.items || []).map(i => `${esc(i.cantidad)} ${esc(i.detalle)}`).join(', ');
    html += `<div style="font-size:13px; padding:5px 0; border-top:1px solid #333;"><b style="color:#00e676;">${formatearFechaHora(p.fecha)}</b> — ${detalle}</div>`;
  });
  cont.innerHTML = html + '</div>';
}

// Al elegir un insumo en la receta, se actualizan las unidades disponibles
document.addEventListener("DOMContentLoaded", () => {
  const selInsumo = document.getElementById('receta-select-insumo');
  if (selInsumo) selInsumo.addEventListener('change', actualizarUnidadesReceta);
});
