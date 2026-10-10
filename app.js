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
    'pantalla-recetas', 'pantalla-calculadora-lote', 'pantalla-grilla', 'pantalla-backup', 'pantalla-borrar'
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
  return conf ? conf.valor : 'productor';
}

async function cambiarRubro() {
  const actual = await obtenerRubro();
  const nuevo = actual === 'revendedor' ? 'productor' : 'revendedor';
  await db.configuracion.put({ clave: 'rubro', valor: nuevo });
  cargarMenu();
}

// Ajustar el menú guiado según el modo activo (Productor / Revendedor)
async function cargarMenu() {
  const rubro = await obtenerRubro();
  document.getElementById('lbl-menu-titulo').innerText = `MENÚ PRINCIPAL (${rubro.toUpperCase()})`;
  document.getElementById('btn-cambiar-rubro').innerText = `Modo activo: ${rubro.charAt(0).toUpperCase() + rubro.slice(1)} (Toca para cambiar)`;
  
  const seccionProductor = document.getElementById('seccion-pasos-productor');
  const seccionGrilla = document.getElementById('seccion-grilla-revendedor');
  const seccionCalcExtra = document.getElementById('seccion-calculadora-extra');
  const numPasoProd = document.getElementById('num-paso-producto');

  if (rubro === 'productor') {
    if (seccionProductor) seccionProductor.classList.remove('hidden');
    if (seccionGrilla) seccionGrilla.classList.add('hidden');
    if (seccionCalcExtra) seccionCalcExtra.classList.remove('hidden');
    if (numPasoProd) numPasoProd.innerText = "3️⃣";
  } else {
    if (seccionProductor) seccionProductor.classList.add('hidden');
    if (seccionGrilla) seccionGrilla.classList.remove('hidden');
    if (seccionCalcExtra) seccionCalcExtra.classList.add('hidden');
    if (numPasoProd) numPasoProd.innerText = "1️⃣";
  }
}

// Validar que haya insumos antes de ir a armar la receta
async function validarYIrARecetas() {
  const cantidadInsumos = await db.insumos.count();
  if (cantidadInsumos === 0) {
    alert("⚠️ ¡Atención!\n\nPrimero debes cargar tus insumos en el PASO 1 (Harina, Cuero, Hilos, etc.) antes de armar la receta.");
    mostrarPantalla('pantalla-insumos');
  } else {
    mostrarPantalla('pantalla-recetas');
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

// CONSULTA DE CATÁLOGO Y STOCK (CON TARJETAS VISUALES Y VENTA DIRECTA)
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
        const unidadIns = ins ? ins.unidad : '';
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

async function importarDesdeEscandallo(