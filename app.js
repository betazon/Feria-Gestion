// Configuración de la base de datos local IndexedDB (Dexie.js)
const db = new Dexie("FeriaDB");
db.version(1).stores({
  productos: 'codigo, detalle, precio_costo, precio_ref, stock, tipo, foto_path',
  ventas: '++id, fecha, codigo, detalle, costo_unit, precio_venta, cantidad, ganancia',
  insumos: '++id, nombre, unidad, costo_unitario, stock',
  recetas: '[codigo_prod+id_insumo], codigo_prod, id_insumo, cantidad_usada',
  configuracion: 'clave, valor'
});

let productoSeleccionadoVenta = null;
let filtroConsultaActual = 'todos';
let ultimosFaltantesCompras = [];
let chartVentasInstancia = null;

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
    'pantalla-portada', 'pantalla-menu', 'pantalla-venta', 'pantalla-reporte',
    'pantalla-reporte-general', 'pantalla-consulta', 'pantalla-nuevo', 'pantalla-insumos', 
    'pantalla-recetas', 'pantalla-grilla', 'pantalla-backup', 'pantalla-borrar'
  ];

  ids.forEach(pId => {
    const el = document.getElementById(pId);
    if (el) el.classList.add('hidden');
  });

  const activo = document.getElementById(id);
  if (activo) activo.classList.remove('hidden');

  if (id === 'pantalla-menu') cargarMenu();
  if (id === 'pantalla-reporte') {
    document.getElementById('reporte-fecha').value = new Date().toISOString().split('T')[0];
    cargarReporteVentas();
  }
  if (id === 'pantalla-reporte-general') actualizarReporteGeneral();
  if (id === 'pantalla-consulta') cargarConsultaStock();
  if (id === 'pantalla-recetas') cargarOpcionesRecetas();
  if (id === 'pantalla-grilla') inicializarGrilla();
}

// Iniciar siempre en la portada y verificar publicidad
document.addEventListener("DOMContentLoaded", async () => {
  mostrarPantalla('pantalla-portada');
  await CargarPublicidadesLocales();
  if (navigator.onLine) {
    await SincronizarPublicidades();
  }
});

// Lógica de Menú y Modo (Productor/Revendedor)
async function obtenerRubro() {
  const conf = await db.configuracion.get('rubro');
  return conf ? conf.valor : 'revendedor';
}

async function cambiarRubro() {
  const actual = await obtenerRubro();
  const nuevo = actual === 'revendedor' ? 'productor' : 'revendedor';
  await db.configuracion.put({ clave: 'rubro', valor: nuevo });
  cargarMenu();
}

async function cargarMenu() {
  const rubro = await obtenerRubro();
  document.getElementById('lbl-menu-titulo').innerText = `MENÚ PRINCIPAL (${rubro.toUpperCase()})`;
  document.getElementById('btn-cambiar-rubro').innerText = `Modo actual: ${rubro.charAt(0).toUpperCase() + rubro.slice(1)} (Toca para cambiar)`;
  
  const btnInsumos = document.getElementById('btn-insumos');
  const btnRecetas = document.getElementById('btn-recetas');
  const btnGrilla = document.getElementById('btn-grilla');

  if (rubro === 'productor') {
    if (btnInsumos) btnInsumos.classList.remove('hidden');
    if (btnRecetas) btnRecetas.classList.remove('hidden');
    if (btnGrilla) btnGrilla.classList.add('hidden');
  } else {
    if (btnInsumos) btnInsumos.classList.add('hidden');
    if (btnRecetas) btnRecetas.classList.add('hidden');
    if (btnGrilla) btnGrilla.classList.remove('hidden');
  }
}

// GESTIÓN DE PUBLICIDAD Y RUBRO DE FERIA
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

// Ventas
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

async function validarYConfirmarVenta() {
  if (!productoSeleccionadoVenta) return alert("Seleccione un producto primero.");
  
  const cant = parseInt(document.getElementById('venta-cant').value || 1);
  const pVenta = parseFloat(document.getElementById('venta-precio').value || 0);
  const stockNuevo = productoSeleccionadoVenta.stock - cant;

  if (stockNuevo < 0) {
    if (!confirm(`¡Stock insuficiente!\nStock actual: ${productoSeleccionadoVenta.stock}\nQuedará en: ${stockNuevo}\n¿Desea vender de todos modos?`)) {
      return;
    }
  }

  await db.ventas.add({
    fecha: new Date().toISOString(),
    codigo: productoSeleccionadoVenta.codigo,
    detalle: productoSeleccionadoVenta.detalle,
    costo_unit: productoSeleccionadoVenta.precio_costo,
    precio_venta: pVenta,
    cantidad: cant,
    ganancia: (pVenta - productoSeleccionadoVenta.precio_costo) * cant
  });

  await db.productos.update(productoSeleccionadoVenta.codigo, { stock: stockNuevo });
  alert("Venta registrada.");

  document.getElementById('venta-buscar').value = '';
  document.getElementById('venta-precio').value = '';
  document.getElementById('venta-cant').value = '1';
  productoSeleccionadoVenta = null;
}

// Reportes Diarios
async function cargarReporteVentas() {
  const fechaSel = document.getElementById('reporte-fecha').value;
  const ventas = await db.ventas.toArray();
  const filtradas = ventas.filter(v => v.fecha.startsWith(fechaSel));

  let totalVendido = 0;
  let totalGanancia = 0;
  let html = '<table><tr><th>Hora</th><th>Detalle</th><th>Cant</th><th>Subtotal</th><th>Ganancia</th></tr>';

  filtradas.forEach((v, i) => {
    const subtotal = v.cantidad * v.precio_venta;
    totalVendido += subtotal;
    totalGanancia += v.ganancia;
    html += `<tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
      <td>${v.fecha.substring(11, 16)}</td><td>${v.detalle}</td><td>${v.cantidad}</td><td>$${subtotal.toFixed(2)}</td><td>$${v.ganancia.toFixed(2)}</td>
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

// ESTADÍSTICAS GENERALES Y FICHA DE PRODUCTO
async function actualizarReporteGeneral() {
  const periodo = document.getElementById('reporte-periodo').value;
  const ventas = await db.ventas.toArray();
  const ahora = new Date();
  let etiquetas = [];
  let totales = [];

  if (periodo === 'dia') {
    const hoyStr = ahora.toISOString().split('T')[0];
    const ventasHoy = ventas.filter(v => v.fecha.startsWith(hoyStr));
    const horasMap = {};
    for (let h = 8; h <= 22; h += 2) {
      const horaLabel = `${h.toString().padStart(2, '0')}:00`;
      horasMap[horaLabel] = 0;
    }

    ventasHoy.forEach(v => {
      const hora = parseInt(v.fecha.substring(11, 13));
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
      const fechaStr = d.toISOString().split('T')[0];
      const diaNombre = d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric' });
      
      const totalDia = ventas
        .filter(v => v.fecha.startsWith(fechaStr))
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
      const unidad = ins ? ins.unidad : '';
      html += `<li>${nombre}: <b>${c.cantidad_usada} ${unidad}</b></li>`;
    }
    contIng.innerHTML = html + '</ul>';
  }

  document.getElementById('reporte-ficha-detalle').classList.remove('hidden');
}

// Consultas
async function cargarConsultaStock(tipo) {
  if (tipo) filtroConsultaActual = tipo;
  const filtroTxt = document.getElementById('consulta-filtro').value.toLowerCase();
  
  let prods = await db.productos.toArray();
  prods = prods.filter(p => {
    const coincideTxt = p.detalle.toLowerCase().includes(filtroTxt) || p.codigo.toLowerCase().includes(filtroTxt);
    const coincideTipo = filtroConsultaActual === 'todos' || p.tipo === filtroConsultaActual;
    return coincideTxt && coincideTipo;
  });

  let html = '<table><tr><th>Cód</th><th>Detalle</th><th>Costo</th><th>P.Ref</th><th>Stk</th></tr>';
  prods.forEach((p, i) => {
    html += `<tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
      <td><b>${p.codigo}</b></td><td>${p.detalle}</td><td>$${p.precio_costo.toFixed(2)}</td><td style="color:#00e676;">$${p.precio_ref.toFixed(2)}</td><td style="color:#ffb74d;">${p.stock}</td>
    </tr>`;
  });
  document.getElementById('consulta-tabla').innerHTML = html + '</table>';
}

// COMPRESIÓN Y PROCESAMIENTO DE FOTOS (Cámara / Galería)
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

// Productos (Alta / Edición)
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
      costoCalculado += ins.costo_unitario * c.cantidad_usada;
    }
  }

  document.getElementById('prod-costo').value = costoCalculado.toFixed(2);
  const margen = 2.0; 
  const precioRefSugerido = costoCalculado * margen;
  document.getElementById('prod-ref').value = precioRefSugerido.toFixed(2);

  document.getElementById('prod-estado').innerText = `Valores sincronizados desde Escandallo (Costo: $${costoCalculado.toFixed(2)})`;
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

// Insumos y Recetas / Calculadora
async function guardarInsumo() {
  const nombre = document.getElementById('insumo-nombre').value.trim();
  if (!nombre) return alert("Ingrese nombre del ingrediente.");

  await db.insumos.add({
    nombre,
    unidad: document.getElementById('insumo-unidad').value.trim() || 'un',
    costo_unitario: parseFloat(document.getElementById('insumo-costo').value || 0),
    stock: parseFloat(document.getElementById('insumo-stock').value || 0)
  });

  alert("Insumo registrado.");
  document.getElementById('insumo-nombre').value = '';
  document.getElementById('insumo-costo').value = '';
  document.getElementById('insumo-stock').value = '';
  cargarOpcionesRecetas();
}

async function cargarOpcionesRecetas() {
  const insumos = await db.insumos.toArray();
  const sel = document.getElementById('receta-select-insumo');
  if (sel) {
    sel.innerHTML = '<option value="">-- Seleccionar Insumo --</option>' + 
      insumos.map(i => `<option value="${i.id}">${i.nombre} (${i.unidad}) - $${i.costo_unitario}/${i.unidad}</option>`).join('');
  }
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

function seleccionarProductoParaReceta(p) {
  document.getElementById('receta-sugerencias-prod').innerHTML = '';
  document.getElementById('receta-buscar-prod').value = p.detalle;
  document.getElementById('receta-cod-prod').value = p.codigo;
  cargarDetalleRecetaRegistrada();
}

async function vincularIngrediente() {
  const codProd = document.getElementById('receta-cod-prod').value.trim();
  const idInsumo = parseInt(document.getElementById('receta-select-insumo').value);
  const cantUsada = parseFloat(document.getElementById('receta-cant-usada').value || 0);

  if (!codProd || !idInsumo || cantUsada <= 0) return alert("Complete código de producto, insumo y cantidad.");
  
  await db.recetas.put({ codigo_prod: codProd, id_insumo: idInsumo, cantidad_usada: cantUsada });
  alert("Ingrediente vinculado a la receta.");
  document.getElementById('receta-cant-usada').value = '';
  cargarDetalleRecetaRegistrada();
}

async function cargarDetalleRecetaRegistrada() {
  const codProd = document.getElementById('receta-cod-prod').value.trim();
  const cont = document.getElementById('receta-ingredientes-lista');
  if (!cont) return;

  if (!codProd) {
    cont.innerHTML = '';
    return;
  }

  const componentes = await db.recetas.where('codigo_prod').equals(codProd).toArray();
  if (componentes.length === 0) {
    cont.innerHTML = '<div style="color:#aaa; font-size:12px; margin-top:5px;">Sin ingredientes cargados para este código.</div>';
    return;
  }

  let html = '<table><tr><th>Insumo</th><th>Cant. Base</th><th>Acción</th></tr>';
  for (let c of componentes) {
    const ins = await db.insumos.get(c.id_insumo);
    const nombreInsumo = ins ? ins.nombre : 'Insumo ' + c.id_insumo;
    const unidad = ins ? ins.unidad : '';
    html += `<tr>
      <td>${nombreInsumo}</td>
      <td>${c.cantidad_usada} ${unidad}</td>
      <td><button class="btn btn-red" style="padding:2px 6px; font-size:11px;" onclick="eliminarIngredienteReceta('${codProd}', ${c.id_insumo})">X</button></td>
    </tr>`;
  }
  cont.innerHTML = html + '</table>';
}

async function eliminarIngredienteReceta(codProd, idInsumo) {
  await db.recetas.where('[codigo_prod+id_insumo]').equals([codProd, idInsumo]).delete();
  cargarDetalleRecetaRegistrada();
}

async function calcularEscandallo() {
  const cod = document.getElementById('receta-cod-prod').value.trim();
  const lote = parseInt(document.getElementById('receta-lote').value || 1);
  if (!cod) return alert("Ingrese un código de producto.");

  const componentes = await db.recetas.where('codigo_prod').equals(cod).toArray();
  if (componentes.length === 0) return alert("No hay receta asignada a este código.");

  let costoUnit = 0;
  ultimosFaltantesCompras = [];
  let htmlMateriales = '<h4>Materiales Necesarios para ' + lote + ' unidad(es):</h4><table><tr><th>Insumo</th><th>Requerido</th><th>Subtotal</th></tr>';

  for (let c of componentes) {
    const ins = await db.insumos.get(c.id_insumo);
    if (ins) {
      const cantTotal = c.cantidad_usada * lote;
      const subtotalInsumo = ins.costo_unitario * cantTotal;
      costoUnit += ins.costo_unitario * c.cantidad_usada;

      htmlMateriales += `<tr>
        <td>${ins.nombre}</td>
        <td><b>${cantTotal.toFixed(2)} ${ins.unidad}</b></td>
        <td>$${subtotalInsumo.toFixed(2)}</td>
      </tr>`;

      if (ins.stock < cantTotal) {
        ultimosFaltantesCompras.push({ nombre: ins.nombre, faltante: cantTotal - ins.stock, unidad: ins.unidad });
      }
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

function compartirComprasWhatsApp() {
  if (ultimosFaltantesCompras.length === 0) return alert("No hay faltantes registrados para el lote calculado.");
  let txt = "*COMPRAS DE INSUMOS FALTANTES*\n\n";
  ultimosFaltantesCompras.forEach(f => {
    txt += `• ${f.nombre}: Faltan ${f.faltante.toFixed(2)} ${f.unidad}\n`;
  });
  window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(txt)}`, '_blank');
}

// Grilla Rápida
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

// Copia de Respaldo y Borrado
async function exportarRespaldo() {
  const datos = {
    productos: await db.productos.toArray(),
    ventas: await db.ventas.toArray(),
    insumos: await db.insumos.toArray(),
    recetas: await db.recetas.toArray()
  };
  const jsonStr = JSON.stringify(datos);
  await navigator.clipboard.writeText(jsonStr);
  alert("Respaldo copiado al portapapeles.");
  window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(jsonStr)}`, '_blank');
}

async function restaurarRespaldo() {
  try {
    const text = await navigator.clipboard.readText();
    const datos = JSON.parse(text);
    if (datos.productos) await db.productos.bulkPut(datos.productos);
    if (datos.ventas) await db.ventas.bulkPut(datos.ventas);
    if (datos.insumos) await db.insumos.bulkPut(datos.insumos);
    if (datos.recetas) await db.recetas.bulkPut(datos.recetas);
    alert("Datos restaurados correctamente.");
  } catch (e) {
    alert("Error al restaurar: " + e.message);
  }
}

async function ejecutarBorrado() {
  const cod = document.getElementById('borrar-codigo').value.trim();
  if (!cod) return alert("Ingrese un código.");
  await db.productos.delete(cod);
  await db.recetas.where('codigo_prod').equals(cod).delete();
  alert("Producto eliminado.");
  document.getElementById('borrar-codigo').value = '';
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