// scraper.js
// Uso: node scraper.js "https://dgi-fep.mef.gob.pa/Consultas/FacturasPorQR?chFE=...&iAmb=...&digestValue=...&jwt=..."
//
// Requiere:
//   npm install axios cheerio @supabase/supabase-js
//
// Variables de entorno necesarias:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY   (service_role key, no la anon key)

const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en las variables de entorno.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function parseNumero(texto) {
  if (!texto) return null;
  const limpio = String(texto).replace(/[^0-9.-]/g, '').trim();
  if (limpio === '') return null;
  const n = parseFloat(limpio);
  return isNaN(n) ? null : n;
}

// Lee todos los pares <dt>/<dd> dentro de un contenedor y los devuelve como {ETIQUETA: valor}
function leerDtDd($, contenedor) {
  const datos = {};
  contenedor.find('dl.dl-vertical').each((_, dl) => {
    const etiqueta = $(dl).find('dt').text().replace(/\s+/g, ' ').trim();
    const valor = $(dl).find('dd').text().replace(/\s+/g, ' ').trim();
    if (etiqueta) datos[etiqueta] = valor;
  });
  return datos;
}

// Busca el panel cuyo encabezado (panel-heading) contiene el texto dado
function buscarPanelPorTitulo($, textoTitulo) {
  let panelEncontrado = null;
  $('.panel').each((_, panel) => {
    const heading = $(panel).find('.panel-heading').first().text().replace(/\s+/g, ' ').trim();
    if (heading.includes(textoTitulo)) {
      panelEncontrado = $(panel);
      return false; // rompe el .each
    }
  });
  return panelEncontrado;
}

// Detecta tamaño de contenido (ej: "946ML" -> {cantidad:946, unidad:'ML'})
// y tamaño de paquete (ej: "12'U" o "PROMO 12U" -> 12 unidades por paquete)
function parseDescripcion(descripcion, cantidadComprada) {
  const resultado = {
    contenido_cantidad: null,
    contenido_unidad: null,
    paquete_cantidad: null,
    vendido_por_peso: false
  };
  if (!descripcion) return resultado;

  // Paquete: número seguido de comilla simple + U, o "U" al final, ej: 12'U, 12U
  const matchPaquete = descripcion.match(/(\d+)\s*'?\s*U\b/i);
  if (matchPaquete) {
    resultado.paquete_cantidad = parseInt(matchPaquete[1], 10);
  }

  // Unidad de medida CON número explícito: ej "946ML", "75 G", "3L"
  const matchUnidad = descripcion.match(/(\d+(?:\.\d+)?)\s*(KG|GR|G|ML|L|MM|CM|OZ|LB)\b\.?/i);
  if (matchUnidad) {
    resultado.contenido_cantidad = parseFloat(matchUnidad[1]);
    resultado.contenido_unidad = matchUnidad[2].toUpperCase();
    return resultado;
  }

  // Productos vendidos por peso: la descripción termina en "KG" SIN número
  // (ej: "PECHUGA KG", "TOMATE PERITA KG") -> el peso real está en "Cantidad"
  if (/\bKG\.?\s*$/i.test(descripcion.trim())) {
    resultado.contenido_cantidad = cantidadComprada;
    resultado.contenido_unidad = 'KG';
    resultado.vendido_por_peso = true;
  }

  return resultado;
}

async function scrapeFactura(url) {
  const { data: html } = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QRLector/1.0)' }
  });

  const $ = cheerio.load(html);

  // --- Encabezado de la factura ---
  const numeroFactura = $('.col-sm-4.text-left h5').first().text().replace(/\s+/g, ' ').trim();
  const fechaEmision = $('.col-sm-4.text-right h5').first().text().replace(/\s+/g, ' ').trim();

  const panelEncabezado = $('.panel-body').first();
  const datosEncabezado = leerDtDd($, panelEncabezado);

  const cufe = datosEncabezado['CÓDIGO ÚNICO DE FACTURA ELECTRÓNICA [CUFE]'] || null;
  const protocoloAutorizacion = datosEncabezado['PROTOCOLO DE AUTORIZACIÓN'] || null;
  const fechaAutorizacion = datosEncabezado['FECHA AUTORIZACIÓN'] || null;

  // --- EMISOR ---
  const panelEmisor = buscarPanelPorTitulo($, 'EMISOR');
  const datosEmisor = panelEmisor ? leerDtDd($, panelEmisor) : {};

  // --- Total pagado / descuentos generales (pie de la tabla) ---
  const textoFooter = $('#detalle tfoot').text();
  const totalPagadoMatch = textoFooter.match(/TOTAL PAGADO:\s*([\d.,]+)/i);
  const descuentosGeneralesMatch = textoFooter.match(/Descuentos:\s*([\d.,]+)/i);

  // --- Detalle de productos (usa los atributos data-title, son estables) ---
  const items = [];
  $('#detalle table tbody tr').each((_, row) => {
    const $row = $(row);
    const celda = (titulo) => $row.find(`td[data-title="${titulo}"]`).text().trim();

    const descripcion = celda('Descripción');
    if (!descripcion) return;

    const cantidadComprada = parseNumero(celda('Cantidad'));
    const { contenido_cantidad, contenido_unidad, paquete_cantidad, vendido_por_peso } =
      parseDescripcion(descripcion, cantidadComprada);

    items.push({
      linea: parseInt(celda('Linea'), 10) || null,
      codigo: celda('Código') || null,
      descripcion,
      info_interes: celda('Información de interés') || null,
      cantidad_comprada: cantidadComprada,                 // cuántas unidades (o kg si vendido_por_peso) se compraron
      contenido_cantidad,                                  // ej: 946 (de "946ML") o el peso si vendido_por_peso
      contenido_unidad,                                    // ej: 'ML' o 'KG'
      paquete_cantidad,                                    // ej: 12 (de "PROMO 12'U")
      vendido_por_peso,
      precio_unitario: parseNumero(celda('Precio')),
      descuento_unitario: parseNumero(celda('Descuento')) || 0,
      monto: parseNumero(celda('Monto')),
      itbms: parseNumero(celda('Impuesto')),
      total_item: parseNumero(celda('Total'))
    });
  });

  return {
    cufe,
    numero_factura: numeroFactura,
    fecha_emision: fechaEmision,
    protocolo_autorizacion: protocoloAutorizacion,
    fecha_autorizacion: fechaAutorizacion,
    emisor_ruc: datosEmisor['RUC'] || null,
    emisor_dv: datosEmisor['DV'] || null,
    emisor_nombre: datosEmisor['NOMBRE'] || null,
    emisor_direccion: datosEmisor['DIRECCIÓN'] || null,
    emisor_telefono: datosEmisor['TELÉFONO'] || null,
    total: totalPagadoMatch ? parseNumero(totalPagadoMatch[1]) : null,
    descuentos_generales: descuentosGeneralesMatch ? parseNumero(descuentosGeneralesMatch[1]) : 0,
    url_origen: url,
    items
  };
}

async function guardarEnSupabase(factura) {
  const { items, ...datosFactura } = factura;

  const { error: errorFactura } = await supabase
    .from('facturas')
    .upsert(datosFactura, { onConflict: 'cufe' });

  if (errorFactura) throw errorFactura;

  if (items.length > 0) {
    await supabase.from('factura_items').delete().eq('factura_cufe', factura.cufe);

    const itemsConCufe = items.map(it => ({ ...it, factura_cufe: factura.cufe }));
    const { error: errorItems } = await supabase.from('factura_items').insert(itemsConCufe);
    if (errorItems) throw errorItems;
  }
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('Uso: node scraper.js "<url-decodificada-del-qr>"');
    process.exit(1);
  }

  console.log('Descargando y procesando factura...');
  const factura = await scrapeFactura(url);

  if (!factura.cufe) {
    console.error('No se pudo extraer el CUFE. Revisa si la estructura de la página cambió.');
    console.log(factura);
    process.exit(1);
  }

  console.log('Datos extraídos:', JSON.stringify(factura, null, 2));

  console.log('Subiendo a Supabase...');
  await guardarEnSupabase(factura);
  console.log('Listo. Factura guardada:', factura.cufe, '- Items:', factura.items.length);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});




<!DOCTYPE html>

<html lang="es-pa">
<head>
    <link rel="icon" type="image/png" href="/Images/favicon.png">
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" /><title>
	
    Consultar Facturas Por QR

</title>

    <script type="text/javascript" src="/ruxitagentjs_ICA7NVfqrux_10341260622154106.js" data-dtconfig="rid=RID_1118994424|rpid=-287797356|domain=mef.gob.pa|reportUrl=/rb_bf36044oye|app=042269121d25fae7|cuc=s94amosz|owasp=1|mel=100000|expw=1|featureHash=ICA7NVfqrux|dpvc=1|lastModification=1783524448613|tp=500,50,0|rdnt=1|uxrgce=1|srbbv=2|agentUri=/ruxitagentjs_ICA7NVfqrux_10341260622154106.js"></script><script type="text/javascript">

        var contexto = '/';
        var timeOut = 5;
    </script>

    <link href="/Scripts/bootstrap-3.3.7/css/bootstrap.min.css" rel="stylesheet"/>
<link href="/Content/Site.css" rel="stylesheet"/>
<script src="/Scripts/modernizr-2.6.2.js"></script>
<link href="/Content/Semantic-UI/semantic.min.css" rel="stylesheet"/>
<script src="/Scripts/jquery-3.5.1.min.js"></script>
<script src="/Scripts/jquery.validate-1.17.min.js"></script>
<script src="/Scripts/jquery.validate.unobtrusive-3.2.7.min.js"></script>
<script src="/Scripts/jquery.unobtrusive-ajax-3.2.4.min.js"></script>
<script src="/Scripts/jquery.form.min.js"></script>
<script src="/Scripts/general.js"></script>
<link href="/Content/jquery-ui/jquery-ui.css" rel="stylesheet"/>
<script src="/Scripts/jquery-ui.min.js"></script>

    <script type="text/javascript">
        $.widget.bridge('uitooltip', $.ui.tooltip);
    </script>


    <script src="/Scripts/bootstrap-3.3.7/js/bootstrap.min.js"></script>
<link href="/Content/footable/footable.bootstrap.min.css" rel="stylesheet"/>
<script src="/Scripts/footable.js"></script>
<link href="/Content/bootstrap-datepicker3.min.css" rel="stylesheet"/>
<script src="/Scripts/bootstrap-datepicker.min.js"></script>
<script src="/Scripts/bootstrap-datepicker.es.min.js"></script>
<script src="/Scripts/jquery.number.min.js"></script>
<script src="/Scripts/Chart.min.js"></script>
<script src="/Scripts/Chart.bundle.min.js"></script>


    <script type="text/javascript" src="https://maps.googleapis.com/maps/api/js?key=AIzaSyCi9aKlyuNshKMPTtKCDvK6w8gA-lEVAxw"></script>

    
    
    <link rel="stylesheet" href="/Content/icomoon/style.css">

    


     <style type="text/css">

        .header-background {
            background-color: #003366;
            background-image: none;
            border-radius: 4px;
            box-shadow: black 0px 0px 1px;
        }

         
        .navbar-default .navbar-nav > li > a:hover, .navbar-default .navbar-nav > li > a:focus {
        color: white;
        background-color: #19114a;

        }

        .modalEspera {
            display:    none;
            position:   fixed;
            z-index:    1000;
            top:        0;
            left:       0;
            height:     100%;
            width:      100%;
            background: rgba( 255, 255, 255, .8 ) 
                        url('../Images/ajax-loader.gif') 
                        50% 50% 
                        no-repeat;
        }

        body.loading {
            overflow: hidden;   
        }

        body.loading .modalEspera {
            display: block;
        }



        .navbar-brand {
          padding: 0px;
        }
        .navbar-brand>img {
          height: 100%;
          padding: 5px;
          width: auto;
        }

         
         

    </style>

    <script src='https://www.google.com/recaptcha/api.js'></script>

    


    
</head>
<body>

   

    <div class="header-background">
        
<!--- TFS 582 -->
<style>
    
    .cep {
        
        margin-left:10px;
        margin-top:10px;
    }
</style>
<!--- FIN TFS 582 -->
<nav class="navbar navbar-default">
    <div>
        <!-- Brand and toggle get grouped for better mobile display -->
        <div class="navbar-header">
            
            <button type="button" class="navbar-toggle collapsed" data-toggle="collapse" data-target="#MenuPrincipal" aria-expanded="false">
                <span class="sr-only">Toggle navigation</span>
                <span class="icon-bar"></span>
                <span class="icon-bar"></span>
                <span class="icon-bar"></span>
            </button>
            <a class="navbar-brand" href="/">
                <img alt="brand" src="/Images/log_gobierno_color.svg" /></a>
            
        </div>

        <!--
            /// <summary>
            // ***********************************************************************
            // Clase          : Menu Principal
            // Autor          : CIAT - Jaime Chung
            // Fecha          : 24/11/2017
            // ***********************************************************************
            /// </summary>
        -->
        <div class="collapse navbar-collapse" id="MenuPrincipal">
            <ul id="2_MainMenu" class="nav navbar-nav"><li><a href='/Sesion/LoginFEP'>Iniciar Sesión</a></li><li class='dropdown'><a href='#' class='dropdown-toggle' data-toggle='dropdown' role='button' aria-haspopup='true' aria-expanded='false'>Consultas<span class='caret'></span></a><ul class='dropdown-menu'><li><a tabindex='-1' href='/Consultas/FacturasPorCUFE' >Facturas por CUFE</a></li><li><a tabindex='-1' href='/Consultas/EmpresasEnFacturaElectronica' >Facturadores Electrónicos</a></li></ul></li></ul> 
                       
        </div>
        <!-- /.navbar-collapse -->
    </div>

    <!-- /.container-fluid -->
</nav>
        

<script type="text/javascript">
    function getCufe() {
        var cufe = document.getElementsByName("CUFE")[0].value;
        var characterReg = /[`~!@#$%^&*()_°¬|+\=?;:'",.<>\{\}\[\]\\\/]/gi;
        var inputVal = cufe;
        if (characterReg.test(cufe)) {
            cufe = inputVal.replace(/[`~!@#$%^&*()_|+\=?;:'",.<>\{\}\[\]\\\/]/gi, '');
        }
        window.location.href = '/Consultas/FacturasPorCUFE/' + cufe;
    }
</script>


    </div>
   
    

    <div class="container-fluid">
        <!-- contenido -->
        <div class="row">
            
                  
        </div>
        <div class="row">
            <div class="col-md-12">
                
            </div>
        </div>
        <div class="row">
            

        <div class="row">
            <div class="col-md-12">
                <!-- contenido -->
                <h1>Consultar Facturas Por QR</h1>
                
                <div class="row" id="facturashow">
                    

                    <div><script xmlns:def="http://dgi-fep.mef.gob.pa">
      function MostrarEvento(numeroEvento){
      $('.listaEventos').hide();
      $('#'+numeroEvento).show();
      }

      $(document).ready(function () {
      jQuery(function ($) {
      $('.table').footable({empty: 'No se encontraron registros'});
      });


      });

      function imprimirFactura(){
        $('#fImprimir').submit();
      }


    </script><div class="row" xmlns:def="http://dgi-fep.mef.gob.pa"><div class="col-sm-12"><div class="panel panel-default"><div class="panel-heading"><div class="row"><div class="col-sm-4 text-left"><h5>
                    No. 8030341786</h5></div><div class="col-sm-4 text-center"><h4><strong>
                          FACTURA
                        </strong></h4></div><div class="col-sm-4 text-right"><h5>30/06/2026 17:28:09</h5></div></div></div><div class="panel-body"><div class="row"><div class="col-sm-2"></div><div class="col-sm-10"><div class="row"><div class="col-sm-8"><dl class="dl-vertical"><dt class="small">CÓDIGO ÚNICO DE FACTURA ELECTRÓNICA [CUFE]</dt><dd style="word-wrap: break-word;">FE01200000032812-2-249262-6300082026063080303417868030311728089076</dd></dl></div><div class="col-sm-4"><dl class="dl-vertical"><dt class="small">PROTOCOLO DE AUTORIZACIÓN</dt><dd>20260000000996855913</dd></dl></div></div><div class="row"><div class="col-sm-8"><dl class="dl-vertical"><dt class="small">MODALIDAD EMISIÓN</dt><dd>
                          Autorización de uso Posterior, Operación normal
                        </dd></dl></div><div class="col-sm-4"><dl class="dl-vertical"><dt class="small">FECHA AUTORIZACIÓN</dt><dd>30/06/2026 17:30:35</dd></dl></div></div></div></div></div><div class="panel-footer text-right"><button type="button" class="btn btn-default" data-toggle="modal" data-target="#myModal">Eventos</button></div></div></div></div><div class="row" xmlns:def="http://dgi-fep.mef.gob.pa"><div class="col-sm-6"><div class="panel panel-default"><div class="panel-heading">
              EMISOR
            </div><div class="panel-body"><div class="row"><div class="col-sm-6"><dl class="dl-vertical"><dt class="small">RUC</dt><dd>32812-2-249262</dd></dl></div><div class="col-sm-6"><dl class="dl-vertical"><dt class="small">DV</dt><dd>63</dd></dl></div><div class="col-sm-6"><dl class="dl-vertical"><dt class="small">NOMBRE</dt><dd>IMPORTADORA VIRZI S.A.</dd></dl></div></div><div class="row"><div class="col-sm-6"><dl class="dl-vertical"><dt class="small">DIRECCIÓN</dt><dd>SUPER CARNES NO. 8. AVE. JUAN DEMOSTENES-VIA SONADORA, PENONOME</dd></dl></div><div class="col-sm-6"><dl class="dl-vertical"><dt class="small">TELÉFONO</dt><dd>958-7118</dd></dl></div></div></div></div></div><div class="col-sm-6"><div class="panel panel-default"><div class="panel-heading"><div class="row"><div class="col-sm-4">
                  RECEPTOR
                </div><div class="col-sm-4"><kbd>
                          CONSUMIDOR FINAL
                        </kbd></div></div></div><div class="panel-body"><div class="row"><div class="col-sm-6"><dl class="dl-vertical"><dt class="small">
                          CÉDULA DE IDENTIDAD
                        </dt><dd>0-000-000</dd></dl></div><div class="col-sm-6"><dl class="dl-vertical"><dt class="small">DV</dt><dd></dd></dl></div><div class="col-sm-6"><dl class="dl-vertical"><dt class="small">NOMBRE</dt><dd>CONSUMIDOR FINAL</dd></dl></div></div><div class="row"><div class="col-sm-6"><dl class="dl-vertical"><dt class="small">DIRECCIÓN</dt><dd>PANAMA</dd></dl></div><div class="col-sm-6"><dl class="dl-vertical"><dt class="small">TELÉFONO</dt><dd></dd></dl></div></div></div></div></div></div><div class="row" xmlns:def="http://dgi-fep.mef.gob.pa"><div class="col-sm-12"><div class="panel panel-default"><div class="panel-heading"><div data-toggle="collapse" data-target="#detalle">
                Detalle <span class="glyphicon glyphicon-th-list"></span></div></div><div class="panel-body collapse in" id="detalle"><table class="table table-striped table-hover"><thead><tr><th data-breakpoints="xs" data-classes="text-center">Linea</th><th data-breakpoints="all" data-classes="text-center">Código</th><th>Descripción</th><th>Información de interés</th><th data-breakpoints="xs" data-classes="text-center">Cantidad</th><th data-breakpoints="xs sm" data-classes="text-right">Precio Unitario</th><th data-breakpoints="xs sm" data-classes="text-right">Descuento Unitario</th><th data-breakpoints="xs sm md" data-classes="text-right">Monto</th><th data-breakpoints="xs sm md" data-classes="text-right">ITBMS</th><th data-breakpoints="all" data-classes="text-right">ISC</th><th data-breakpoints="all" data-classes="text-right">Acarreo</th><th data-breakpoints="all" data-classes="text-right">Seguro</th><th data-classes="text-right">Total</th></tr></thead><tbody><tr><td data-title="Linea" class="text-center">1</td><td data-title="Código" class="text-center">00212</td><td data-title="Descripción" class="text-left">PECHUGA KG</td><td data-title="Información de interés" class="text-left">BHCT-341786-1</td><td data-title="Cantidad" class="text-center">1.000000</td><td data-title="Precio" class="text-right">1.966360</td><td data-title="Descuento" class="text-right"></td><td data-title="Monto" class="text-right">1.966360</td><td data-title="Impuesto" class="text-right">0.000000</td><td data-title="ISC" class="text-right"></td><td data-title="Acarreo" class="text-right">0.00</td><td data-title="Seguro" class="text-right">0.00</td><td data-title="Total" class="text-right">1.966360</td></tr><tr><td data-title="Linea" class="text-center">2</td><td data-title="Código" class="text-center">00212</td><td data-title="Descripción" class="text-left">PECHUGA KG</td><td data-title="Información de interés" class="text-left">BHCT-341786-2</td><td data-title="Cantidad" class="text-center">1.148000</td><td data-title="Precio" class="text-right">2.180000</td><td data-title="Descuento" class="text-right"></td><td data-title="Monto" class="text-right">2.502640</td><td data-title="Impuesto" class="text-right">0.000000</td><td data-title="ISC" class="text-right"></td><td data-title="Acarreo" class="text-right">0.00</td><td data-title="Seguro" class="text-right">0.00</td><td data-title="Total" class="text-right">2.502640</td></tr><tr><td data-title="Linea" class="text-center">3</td><td data-title="Código" class="text-center">7441003560130</td><td data-title="Descripción" class="text-left">BEBIDA DEL VALLE FRESH CITRICOS 3L</td><td data-title="Información de interés" class="text-left">BHCT-341786-3</td><td data-title="Cantidad" class="text-center">1.000000</td><td data-title="Precio" class="text-right">1.690000</td><td data-title="Descuento" class="text-right"></td><td data-title="Monto" class="text-right">1.690000</td><td data-title="Impuesto" class="text-right">0.000000</td><td data-title="ISC" class="text-right"></td><td data-title="Acarreo" class="text-right">0.00</td><td data-title="Seguro" class="text-right">0.00</td><td data-title="Total" class="text-right">1.690000</td></tr><tr><td data-title="Linea" class="text-center">4</td><td data-title="Código" class="text-center">7441001014253</td><td data-title="Descripción" class="text-left">PICARONAS CHILE JACK'S 75 G</td><td data-title="Información de interés" class="text-left">BHCT-341786-4</td><td data-title="Cantidad" class="text-center">1.000000</td><td data-title="Precio" class="text-right">0.760000</td><td data-title="Descuento" class="text-right"></td><td data-title="Monto" class="text-right">0.760000</td><td data-title="Impuesto" class="text-right">0.000000</td><td data-title="ISC" class="text-right"></td><td data-title="Acarreo" class="text-right">0.00</td><td data-title="Seguro" class="text-right">0.00</td><td data-title="Total" class="text-right">0.760000</td></tr><tr><td data-title="Linea" class="text-center">5</td><td data-title="Código" class="text-center">00425</td><td data-title="Descripción" class="text-left">TOMATE PERITA KG</td><td data-title="Información de interés" class="text-left">BHCT-341786-5</td><td data-title="Cantidad" class="text-center">1.000000</td><td data-title="Precio" class="text-right">1.459640</td><td data-title="Descuento" class="text-right"></td><td data-title="Monto" class="text-right">1.459640</td><td data-title="Impuesto" class="text-right">0.000000</td><td data-title="ISC" class="text-right"></td><td data-title="Acarreo" class="text-right">0.00</td><td data-title="Seguro" class="text-right">0.00</td><td data-title="Total" class="text-right">1.459640</td></tr><tr><td data-title="Linea" class="text-center">6</td><td data-title="Código" class="text-center">00492</td><td data-title="Descripción" class="text-left">LECHUGA ROMANA ROBETTO KG</td><td data-title="Información de interés" class="text-left">BHCT-341786-6</td><td data-title="Cantidad" class="text-center">1.000000</td><td data-title="Precio" class="text-right">0.724680</td><td data-title="Descuento" class="text-right"></td><td data-title="Monto" class="text-right">0.724680</td><td data-title="Impuesto" class="text-right">0.000000</td><td data-title="ISC" class="text-right"></td><td data-title="Acarreo" class="text-right">0.00</td><td data-title="Seguro" class="text-right">0.00</td><td data-title="Total" class="text-right">0.724680</td></tr><tr><td data-title="Linea" class="text-center">7</td><td data-title="Código" class="text-center">74501823</td><td data-title="Descripción" class="text-left">RIKA AID CEREZA 8 G</td><td data-title="Información de interés" class="text-left">BHCT-341786-7</td><td data-title="Cantidad" class="text-center">2.000000</td><td data-title="Precio" class="text-right">0.130000</td><td data-title="Descuento" class="text-right"></td><td data-title="Monto" class="text-right">0.260000</td><td data-title="Impuesto" class="text-right">0.000000</td><td data-title="ISC" class="text-right"></td><td data-title="Acarreo" class="text-right">0.00</td><td data-title="Seguro" class="text-right">0.00</td><td data-title="Total" class="text-right">0.260000</td></tr><tr><td data-title="Linea" class="text-center">8</td><td data-title="Código" class="text-center">00478</td><td data-title="Descripción" class="text-left">CEBOLLA NACIONAL KG</td><td data-title="Información de interés" class="text-left">BHCT-341786-8</td><td data-title="Cantidad" class="text-center">1.000000</td><td data-title="Precio" class="text-right">0.306240</td><td data-title="Descuento" class="text-right"></td><td data-title="Monto" class="text-right">0.306240</td><td data-title="Impuesto" class="text-right">0.000000</td><td data-title="ISC" class="text-right"></td><td data-title="Acarreo" class="text-right">0.00</td><td data-title="Seguro" class="text-right">0.00</td><td data-title="Total" class="text-right">0.306240</td></tr><tr><td data-title="Linea" class="text-center">9</td><td data-title="Código" class="text-center">01005</td><td data-title="Descripción" class="text-left">PAN FRANCES KG.</td><td data-title="Información de interés" class="text-left">BHCT-341786-9</td><td data-title="Cantidad" class="text-center">1.000000</td><td data-title="Precio" class="text-right">0.849420</td><td data-title="Descuento" class="text-right"></td><td data-title="Monto" class="text-right">0.849420</td><td data-title="Impuesto" class="text-right">0.000000</td><td data-title="ISC" class="text-right"></td><td data-title="Acarreo" class="text-right">0.00</td><td data-title="Seguro" class="text-right">0.00</td><td data-title="Total" class="text-right">0.849420</td></tr><tr><td data-title="Linea" class="text-center">10</td><td data-title="Código" class="text-center">721282409441</td><td data-title="Descripción" class="text-left">LAYS QUESO BLANCO 1 OZ</td><td data-title="Información de interés" class="text-left">BHCT-341786-10</td><td data-title="Cantidad" class="text-center">4.000000</td><td data-title="Precio" class="text-right">0.567500</td><td data-title="Descuento" class="text-right">0.070000</td><td data-title="Monto" class="text-right">1.990000</td><td data-title="Impuesto" class="text-right">0.000000</td><td data-title="ISC" class="text-right"></td><td data-title="Acarreo" class="text-right">0.00</td><td data-title="Seguro" class="text-right">0.00</td><td data-title="Total" class="text-right">1.990000</td></tr><tr><td data-title="Linea" class="text-center">11</td><td data-title="Código" class="text-center">01005</td><td data-title="Descripción" class="text-left">PAN FRANCES KG.</td><td data-title="Información de interés" class="text-left">BHCT-341786-11</td><td data-title="Cantidad" class="text-center">1.000000</td><td data-title="Precio" class="text-right">0.835380</td><td data-title="Descuento" class="text-right"></td><td data-title="Monto" class="text-right">0.835380</td><td data-title="Impuesto" class="text-right">0.000000</td><td data-title="ISC" class="text-right"></td><td data-title="Acarreo" class="text-right">0.00</td><td data-title="Seguro" class="text-right">0.00</td><td data-title="Total" class="text-right">0.835380</td></tr><tr><td data-title="Linea" class="text-center">12</td><td data-title="Código" class="text-center">01005</td><td data-title="Descripción" class="text-left">PAN FRANCES KG.</td><td data-title="Información de interés" class="text-left">BHCT-341786-12</td><td data-title="Cantidad" class="text-center">1.000000</td><td data-title="Precio" class="text-right">1.740960</td><td data-title="Descuento" class="text-right"></td><td data-title="Monto" class="text-right">1.740960</td><td data-title="Impuesto" class="text-right">0.000000</td><td data-title="ISC" class="text-right"></td><td data-title="Acarreo" class="text-right">0.00</td><td data-title="Seguro" class="text-right">0.00</td><td data-title="Total" class="text-right">1.740960</td></tr><tr><td data-title="Linea" class="text-center">13</td><td data-title="Código" class="text-center">7501058643230</td><td data-title="Descripción" class="text-left">TRIX CEREAL TETRIS NESTLE 30G</td><td data-title="Información de interés" class="text-left">BHCT-341786-13</td><td data-title="Cantidad" class="text-center">1.000000</td><td data-title="Precio" class="text-right">0.500000</td><td data-title="Descuento" class="text-right"></td><td data-title="Monto" class="text-right">0.500000</td><td data-title="Impuesto" class="text-right">0.000000</td><td data-title="ISC" class="text-right"></td><td data-title="Acarreo" class="text-right">0.00</td><td data-title="Seguro" class="text-right">0.00</td><td data-title="Total" class="text-right">0.500000</td></tr><tr><td data-title="Linea" class="text-center">14</td><td data-title="Código" class="text-center">7702031800682</td><td data-title="Descripción" class="text-left">STAYFREE ESPECIAL ALAS PROMO 12'U</td><td data-title="Información de interés" class="text-left">BHCT-341786-14</td><td data-title="Cantidad" class="text-center">1.000000</td><td data-title="Precio" class="text-right">1.450000</td><td data-title="Descuento" class="text-right"></td><td data-title="Monto" class="text-right">1.450000</td><td data-title="Impuesto" class="text-right">0.101500</td><td data-title="ISC" class="text-right"></td><td data-title="Acarreo" class="text-right">0.00</td><td data-title="Seguro" class="text-right">0.00</td><td data-title="Total" class="text-right">1.551500</td></tr><tr><td data-title="Linea" class="text-center">15</td><td data-title="Código" class="text-center">7501058643247</td><td data-title="Descripción" class="text-left">NESQUIK CEREAL TETRIS NESTLE 30 G</td><td data-title="Información de interés" class="text-left">BHCT-341786-15</td><td data-title="Cantidad" class="text-center">1.000000</td><td data-title="Precio" class="text-right">0.500000</td><td data-title="Descuento" class="text-right"></td><td data-title="Monto" class="text-right">0.500000</td><td data-title="Impuesto" class="text-right">0.000000</td><td data-title="ISC" class="text-right"></td><td data-title="Acarreo" class="text-right">0.00</td><td data-title="Seguro" class="text-right">0.00</td><td data-title="Total" class="text-right">0.500000</td></tr><tr><td data-title="Linea" class="text-center">16</td><td data-title="Código" class="text-center">7702011005397</td><td data-title="Descripción" class="text-left">WAFER CON AVELLANA NUCITA 160GR</td><td data-title="Información de interés" class="text-left">BHCT-341786-16</td><td data-title="Cantidad" class="text-center">1.000000</td><td data-title="Precio" class="text-right">1.180000</td><td data-title="Descuento" class="text-right"></td><td data-title="Monto" class="text-right">1.180000</td><td data-title="Impuesto" class="text-right">0.000000</td><td data-title="ISC" class="text-right"></td><td data-title="Acarreo" class="text-right">0.00</td><td data-title="Seguro" class="text-right">0.00</td><td data-title="Total" class="text-right">1.180000</td></tr><tr><td data-title="Linea" class="text-center">17</td><td data-title="Código" class="text-center">7700591062137</td><td data-title="Descripción" class="text-left">CHIPS DE PLATANO NATURAL TURBANA 85G</td><td data-title="Información de interés" class="text-left">BHCT-341786-17</td><td data-title="Cantidad" class="text-center">2.000000</td><td data-title="Precio" class="text-right">0.990000</td><td data-title="Descuento" class="text-right"></td><td data-title="Monto" class="text-right">1.980000</td><td data-title="Impuesto" class="text-right">0.000000</td><td data-title="ISC" class="text-right"></td><td data-title="Acarreo" class="text-right">0.00</td><td data-title="Seguro" class="text-right">0.00</td><td data-title="Total" class="text-right">1.980000</td></tr><tr><td data-title="Linea" class="text-center">18</td><td data-title="Código" class="text-center">755111185060</td><td data-title="Descripción" class="text-left">GALLETAS ARTESANAS ORIGINAL 100G</td><td data-title="Información de interés" class="text-left">BHCT-341786-18</td><td data-title="Cantidad" class="text-center">2.000000</td><td data-title="Precio" class="text-right">0.680000</td><td data-title="Descuento" class="text-right"></td><td data-title="Monto" class="text-right">1.360000</td><td data-title="Impuesto" class="text-right">0.000000</td><td data-title="ISC" class="text-right"></td><td data-title="Acarreo" class="text-right">0.00</td><td data-title="Seguro" class="text-right">0.00</td><td data-title="Total" class="text-right">1.360000</td></tr><tr><td data-title="Linea" class="text-center">19</td><td data-title="Código" class="text-center">7451017800115</td><td data-title="Descripción" class="text-left">MARGARINA HELMET BARRA 113G</td><td data-title="Información de interés" class="text-left">BHCT-341786-19</td><td data-title="Cantidad" class="text-center">1.000000</td><td data-title="Precio" class="text-right">0.460000</td><td data-title="Descuento" class="text-right"></td><td data-title="Monto" class="text-right">0.460000</td><td data-title="Impuesto" class="text-right">0.000000</td><td data-title="ISC" class="text-right"></td><td data-title="Acarreo" class="text-right">0.00</td><td data-title="Seguro" class="text-right">0.00</td><td data-title="Total" class="text-right">0.460000</td></tr><tr><td data-title="Linea" class="text-center">20</td><td data-title="Código" class="text-center">01181</td><td data-title="Descripción" class="text-left">QUESO NESTLE AMERICANO INDIVIDUAL KG.</td><td data-title="Información de interés" class="text-left">BHCT-341786-20</td><td data-title="Cantidad" class="text-center">1.000000</td><td data-title="Precio" class="text-right">1.740700</td><td data-title="Descuento" class="text-right"></td><td data-title="Monto" class="text-right">1.740700</td><td data-title="Impuesto" class="text-right">0.000000</td><td data-title="ISC" class="text-right"></td><td data-title="Acarreo" class="text-right">0.00</td><td data-title="Seguro" class="text-right">0.00</td><td data-title="Total" class="text-right">1.740700</td></tr><tr><td data-title="Linea" class="text-center">21</td><td data-title="Código" class="text-center">7452096901588</td><td data-title="Descripción" class="text-left">LECHE ENTERA LA CHIRICANA 946ML</td><td data-title="Información de interés" class="text-left">BHCT-341786-21</td><td data-title="Cantidad" class="text-center">1.000000</td><td data-title="Precio" class="text-right">1.690000</td><td data-title="Descuento" class="text-right"></td><td data-title="Monto" class="text-right">1.690000</td><td data-title="Impuesto" class="text-right">0.000000</td><td data-title="ISC" class="text-right"></td><td data-title="Acarreo" class="text-right">0.00</td><td data-title="Seguro" class="text-right">0.00</td><td data-title="Total" class="text-right">1.690000</td></tr></tbody><tfoot><tr><td class="text-right" colspan="12">
                        Descuentos: <div style="width: 100px;display: inline-block;">0.00</div></td></tr><tr><td class="text-right" colspan="12">
                      Valor Total: <div style="width: 100px;display: inline-block;">26.05</div></td></tr><tr><td class="text-right" colspan="12">
                      ITBMS Total: <div style="width: 100px;display: inline-block;">0.10</div></td></tr><tr><td class="text-right" colspan="12"><kbd>Forma de Pago</kbd><div style="width: 100px;display: inline-block;"></div></td></tr><tr><td class="text-right" colspan="12">
                            Tarjeta Débito: <div style="width: 100px;display: inline-block;">26.05</div></td></tr><tr><td class="text-right" colspan="12">
                            TOTAL PAGADO: <div style="width: 100px;display: inline-block;">26.05</div></td></tr><tr><td class="text-right" colspan="12">
                            Vuelto: <div style="width: 100px;display: inline-block;">0.00</div></td></tr></tfoot></table></div></div></div></div><div class="row" xmlns:def="http://dgi-fep.mef.gob.pa"><div class="col-sm-12"><div class="panel panel-default"><div class="panel-heading">
              INFORMACION COMERCIAL GENERAL
            </div><div class="panel-body"><div class="row"><div class="col-sm-2"><dl class="dl-vertical"><dt class="small">No. Pedido o Referencia</dt><dd></dd></dl></div><div class="col-sm-8"><dl class="dl-vertical"><dt class="small">Información del Pedido</dt><dd></dd></dl></div></div></div></div></div></div><div class="row" xmlns:def="http://dgi-fep.mef.gob.pa"><div class="col-md-5"></div><div class="col-md-2" style="text-align: center;"><a class="btn btn-primary btn-lg" onclick="imprimirFactura(); return false;"><span class="icon-pdf" style="font-size: 30px;"></span><br>Descargar CAFE
        </a></div><div class="col-md-5"></div></div><div id="myModal" class="modal fade" role="dialog" xmlns:def="http://dgi-fep.mef.gob.pa"><div class="modal-dialog modal-lg"><div class="modal-content"><div class="modal-header"><button type="button" class="close" data-dismiss="modal"></button><h4 class="modal-title">Eventos</h4></div><div class="modal-body"><div class="panel panel-default"><div class="panel-heading"><h3 class="panel-title">Lista de Eventos</h3></div><div class="panel-body"><table class="table table-striped table-hover"><thead><tr><th>Fecha Autorización</th><th>Tipo Evento</th><th data-breakpoints="xs sm md">Ver</th></tr></thead><tbody id="tbodyResultado"><tr><td>30/06/2026 17:30:35</td><td>
                              Autorización
                            </td><td><a href="#" onclick="MostrarEvento('pa_1'); return false;"><i class="glyphicon glyphicon-eye-open"></i></a></td></tr></tbody></table></div></div><div class="panel panel-default listaEventos" id="pa_1" style="display: none;"><div class="panel-heading"><h3 class="panel-title">Evento</h3></div><div class="panel-body"><div class="row"><div class="col-md-6"><label>Fecha Autorización</label><div>30/06/2026 17:30:35</div></div><div class="col-md-6"><label>Tipo Evento</label><div>
                          Autorización
                        </div></div></div></div></div></div><div class="modal-footer"><button type="button" class="btn btn-default" data-dismiss="modal">Cerrar</button></div></div></div></div></div>
                    
                    <form action="/Consultas/DescargarFacturaPDF" id="fImprimir" method="post" target="ifImprimir">
                        <input id="facturaXML" name="facturaXML" type="hidden" value="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" />
                    </form>
                    <iframe id="ifImprimir" name="ifImprimir" style="width: 0px; height: 0px;"/>

                    
                </div>
            </div>
        </div>
    


    <script>

        $(document).ready(function () {
            $('.dropdown-toggle2').on('click', function (el) {
                $('dropdown-toggle2').dropdown();
            });
        });

        function buscarCUFE() {
            var cufe = document.getElementsByName("inputCUFE")[0].value;
            window.location.href = '/Consultas/FacturasPorCUFE/' + cufe;
        }


    </script>


        </div>
        
    </div>
    <div class="footer pieMenu">
            <div>
                <div class="text-right" style="padding-right: 1em;">
                    <p>Ministerio de Economía y Finanzas</p>
                    <p><a href="http://disclaimer.innovacion.gob.pa/">Limitación de Responsabilidad</a> | <a href="https://dgi.mef.gob.pa/Condicion.php">Condiciones de Uso</a> - DGI - WB ALPHA | <strong>Versión:</strong> 1.0.0.0</p>
                </div>
            </div>
        </div>
     <div id="modalEspera" class="modalEspera"></div>


    <div id="ventanaMensajes" class="modal modal-wide" role="dialog">
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header">
            <h4 class="modal-title" id="tituloVentanaMensajes"></h4>
          </div>
          <div class="modal-body">
            <p id="cuerpoVentanaMensajes" style="text-align:justify;"></p>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-default" data-dismiss="modal">Cerrar</button>
          </div>
        </div>

      </div>
    </div>

    
</body>
</html>

<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Lector QR</title>
<script src="https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.0/dist/iife/reader/index.js"></script>
<style>
  body {
    font-family: -apple-system, Arial, sans-serif;
    max-width: 480px;
    margin: 0 auto;
    padding: 16px;
    background: #111;
    color: #eee;
    text-align: center;
  }
  h1 { font-size: 1.2rem; }
  #videoWrap {
    position: relative;
    width: 100%;
    border-radius: 12px;
    overflow: hidden;
    background: #000;
  }
  video { width: 100%; display: block; }
  #overlay {
    position: absolute;
    top: 15%; left: 15%; right: 15%; bottom: 15%;
    border: 3px solid #4da3ff;
    border-radius: 12px;
    pointer-events: none;
  }
  canvas { display: none; }
  #resultado {
    margin-top: 16px;
    padding: 12px;
    background: #222;
    border-radius: 8px;
    word-break: break-all;
    text-align: left;
    font-size: 0.9rem;
    display: none;
  }
  #resultado a { color: #4da3ff; }
  button {
    margin-top: 10px;
    padding: 10px 20px;
    border: none;
    border-radius: 8px;
    background: #4da3ff;
    color: #fff;
    font-size: 0.95rem;
    cursor: pointer;
  }
  #estado { font-size: 0.85rem; color: #aaa; margin-top: 8px; min-height: 1.2em; }
  #errorLog {
    margin-top: 10px;
    padding: 10px;
    background: #2a1414;
    border: 1px solid #7a2b2b;
    border-radius: 8px;
    font-size: 0.8rem;
    text-align: left;
    color: #ff9a9a;
    display: none;
    max-height: 140px;
    overflow-y: auto;
  }
  .fallback {
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid #333;
  }
  input[type=file] { display: none; }
  label.fileBtn {
    display: inline-block;
    margin-top: 8px;
    padding: 10px 20px;
    border-radius: 8px;
    background: #333;
    color: #eee;
    font-size: 0.95rem;
    cursor: pointer;
  }
</style>
</head>
<body>

<h1>Escanea el código QR</h1>
<div id="estado">Cargando motor de lectura...</div>

<div id="videoWrap">
  <video id="video" playsinline muted autoplay></video>
  <div id="overlay"></div>
</div>
<canvas id="canvas"></canvas>
<div id="errorLog"></div>

<div id="resultado"></div>
<button id="btnReset" style="display:none;">Escanear otro</button>

<div class="fallback">
  <div style="font-size:0.85rem; color:#999;">¿No lo lee con la cámara? Sube una foto del QR:</div>
  <label class="fileBtn" for="fileInput">Subir foto</label>
  <input type="file" id="fileInput" accept="image/*" capture="environment">
</div>

<script>
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const resultadoDiv = document.getElementById('resultado');
const estadoDiv = document.getElementById('estado');
const errorLogDiv = document.getElementById('errorLog');
const btnReset = document.getElementById('btnReset');
const fileInput = document.getElementById('fileInput');

let stream = null;
let scanning = false;
let scanTimer = null;
let intentosSinExito = 0;

const readerOptions = {
  tryHarder: true,
  formats: ["QRCode"],
  maxNumberOfSymbols: 1
};

function mostrarResultado(text) {
  detenerCamara();
  document.getElementById('videoWrap').style.display = 'none';
  estadoDiv.style.display = 'none';
  errorLogDiv.style.display = 'none';
  resultadoDiv.style.display = 'block';

  let html = `<strong>Contenido leído:</strong><br>${text}`;
  if (text.startsWith('http')) {
    html += `<br><br><a href="${text}" target="_blank">Abrir enlace</a>`;
  }
  resultadoDiv.innerHTML = html;
  btnReset.style.display = 'inline-block';
}

function mostrarError(msg) {
  errorLogDiv.style.display = 'block';
  errorLogDiv.textContent = msg;
}

async function decodeFrame() {
  if (!scanning || video.videoWidth === 0) return;

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  try {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const results = await ZXingWASM.readBarcodes(imageData, readerOptions);
    if (results && results.length > 0 && results[0].text) {
      mostrarResultado(results[0].text);
      return;
    }
    intentosSinExito++;
    if (intentosSinExito === 25) {
      mostrarError(
        'Llevamos varios segundos sin poder leer el QR. ' +
        'Sugerencias: acércate más, evita reflejos de luz sobre el papel, ' +
        'asegúrate que el QR completo esté dentro del recuadro, ' +
        'o usa la opción de "Subir foto" abajo (suele funcionar mejor con QR muy densos).'
      );
    }
  } catch (e) {
    // Frame sin QR válido, seguimos intentando
  }

  scanTimer = setTimeout(decodeFrame, 350);
}

function detenerCamara() {
  scanning = false;
  if (scanTimer) clearTimeout(scanTimer);
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
}

async function iniciarCamara() {
  intentosSinExito = 0;
  errorLogDiv.style.display = 'none';
  resultadoDiv.style.display = 'none';
  btnReset.style.display = 'none';
  document.getElementById('videoWrap').style.display = 'block';
  estadoDiv.style.display = 'block';
  estadoDiv.textContent = 'Apunta la cámara al QR y acércate hasta que enfoque';

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    });
    video.srcObject = stream;
    await video.play();
    scanning = true;
    decodeFrame();
  } catch (err) {
    estadoDiv.textContent = '';
    mostrarError('No se pudo acceder a la cámara: ' + err.message);
  }
}

btnReset.addEventListener('click', () => {
  fileInput.value = '';
  iniciarCamara();
});

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  detenerCamara();
  estadoDiv.style.display = 'block';
  estadoDiv.textContent = 'Procesando imagen...';
  errorLogDiv.style.display = 'none';

  try {
    const results = await ZXingWASM.readBarcodes(file, readerOptions);
    if (results && results.length > 0 && results[0].text) {
      mostrarResultado(results[0].text);
    } else {
      estadoDiv.textContent = '';
      mostrarError(
        'No se encontró ningún QR en esa imagen. Intenta con una foto más nítida, ' +
        'bien iluminada, sin reflejos y tomada de frente al QR.'
      );
    }
  } catch (err) {
    estadoDiv.textContent = '';
    mostrarError('Error al procesar la imagen: ' + err.message);
  }
});

window.addEventListener('load', () => {
  estadoDiv.textContent = 'Iniciando cámara...';
  iniciarCamara();
});
</script>

</body>
</html>
