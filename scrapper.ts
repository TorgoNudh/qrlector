// supabase/functions/scrape-factura/index.ts
//
// Edge Function: recibe la URL decodificada del QR de una factura del DGI,
// hace scraping de la página, y guarda los datos en las tablas
// `facturas` y `factura_items`.
//
// Deploy:
//   supabase functions deploy scrape-factura
//// supabase/functions/scrape-factura/index.ts
//
// Edge Function: recibe la URL decodificada del QR de una factura del DGI,
// hace scraping de la página, y guarda los datos en las tablas
// `facturas` y `factura_items`.
//
// Deploy:
//   supabase functions deploy scrape-factura
//
// Esta función usa las variables de entorno que Supabase inyecta automáticamente
// en cada Edge Function (no hace falta configurarlas a mano):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as cheerio from "npm:cheerio@1.0.0";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function parseNumero(texto: string | null | undefined): number | null {
  if (!texto) return null;
  const limpio = String(texto).replace(/[^0-9.-]/g, "").trim();
  if (limpio === "") return null;
  const n = parseFloat(limpio);
  return isNaN(n) ? null : n;
}

function leerDtDd($: cheerio.CheerioAPI, contenedor: any): Record<string, string> {
  const datos: Record<string, string> = {};
  contenedor.find("dl.dl-vertical").each((_: number, dl: any) => {
    const etiqueta = $(dl).find("dt").text().replace(/\s+/g, " ").trim();
    const valor = $(dl).find("dd").text().replace(/\s+/g, " ").trim();
    if (etiqueta) datos[etiqueta] = valor;
  });
  return datos;
}

function buscarPanelPorTitulo($: cheerio.CheerioAPI, textoTitulo: string) {
  let panelEncontrado: any = null;
  $(".panel").each((_: number, panel: any) => {
    const heading = $(panel).find(".panel-heading").first().text().replace(/\s+/g, " ").trim();
    if (heading.includes(textoTitulo)) {
      panelEncontrado = $(panel);
      return false;
    }
  });
  return panelEncontrado;
}

function parseDescripcion(descripcion: string, cantidadComprada: number | null) {
  const resultado = {
    contenido_cantidad: null as number | null,
    contenido_unidad: null as string | null,
    paquete_cantidad: null as number | null,
    vendido_por_peso: false,
  };
  if (!descripcion) return resultado;

  const matchPaquete = descripcion.match(/(\d+)\s*'?\s*U\b/i);
  if (matchPaquete) resultado.paquete_cantidad = parseInt(matchPaquete[1], 10);

  const matchUnidad = descripcion.match(/(\d+(?:\.\d+)?)\s*(KG|GR|G|ML|L|MM|CM|OZ|LB)\b\.?/i);
  if (matchUnidad) {
    resultado.contenido_cantidad = parseFloat(matchUnidad[1]);
    resultado.contenido_unidad = matchUnidad[2].toUpperCase();
    return resultado;
  }

  if (/\bKG\.?\s*$/i.test(descripcion.trim())) {
    resultado.contenido_cantidad = cantidadComprada;
    resultado.contenido_unidad = "KG";
    resultado.vendido_por_peso = true;
  }

  return resultado;
}

async function scrapeFactura(url: string) {
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; QRLector/1.0)" },
  });
  const html = await resp.text();
  const $ = cheerio.load(html);

  const numeroFactura = $(".col-sm-4.text-left h5").first().text().replace(/\s+/g, " ").trim();
  const fechaEmision = $(".col-sm-4.text-right h5").first().text().replace(/\s+/g, " ").trim();

  const panelEncabezado = $(".panel-body").first();
  const datosEncabezado = leerDtDd($, panelEncabezado);

  const cufe = datosEncabezado["CÓDIGO ÚNICO DE FACTURA ELECTRÓNICA [CUFE]"] || null;
  const protocoloAutorizacion = datosEncabezado["PROTOCOLO DE AUTORIZACIÓN"] || null;
  const fechaAutorizacion = datosEncabezado["FECHA AUTORIZACIÓN"] || null;

  const panelEmisor = buscarPanelPorTitulo($, "EMISOR");
  const datosEmisor = panelEmisor ? leerDtDd($, panelEmisor) : {};

  const textoFooter = $("#detalle tfoot").text();
  const totalPagadoMatch = textoFooter.match(/TOTAL PAGADO:\s*([\d.,]+)/i);
  const descuentosGeneralesMatch = textoFooter.match(/Descuentos:\s*([\d.,]+)/i);

  const items: any[] = [];
  $("#detalle table tbody tr").each((_: number, row: any) => {
    const $row = $(row);
    const celda = (titulo: string) => $row.find(`td[data-title="${titulo}"]`).text().trim();

    const descripcion = celda("Descripción");
    if (!descripcion) return;

    const cantidadComprada = parseNumero(celda("Cantidad"));
    const { contenido_cantidad, contenido_unidad, paquete_cantidad, vendido_por_peso } =
      parseDescripcion(descripcion, cantidadComprada);

    items.push({
      linea: parseInt(celda("Linea"), 10) || null,
      codigo: celda("Código") || null,
      descripcion,
      info_interes: celda("Información de interés") || null,
      cantidad_comprada: cantidadComprada,
      contenido_cantidad,
      contenido_unidad,
      paquete_cantidad,
      vendido_por_peso,
      precio_unitario: parseNumero(celda("Precio")),
      descuento_unitario: parseNumero(celda("Descuento")) || 0,
      monto: parseNumero(celda("Monto")),
      itbms: parseNumero(celda("Impuesto")),
      total_item: parseNumero(celda("Total")),
    });
  });

  return {
    cufe,
    numero_factura: numeroFactura,
    fecha_emision: fechaEmision,
    protocolo_autorizacion: protocoloAutorizacion,
    fecha_autorizacion: fechaAutorizacion,
    emisor_ruc: datosEmisor["RUC"] || null,
    emisor_dv: datosEmisor["DV"] || null,
    emisor_nombre: datosEmisor["NOMBRE"] || null,
    emisor_direccion: datosEmisor["DIRECCIÓN"] || null,
    emisor_telefono: datosEmisor["TELÉFONO"] || null,
    total: totalPagadoMatch ? parseNumero(totalPagadoMatch[1]) : null,
    descuentos_generales: descuentosGeneralesMatch ? parseNumero(descuentosGeneralesMatch[1]) : 0,
    url_origen: url,
    items,
  };
}

async function guardarEnSupabase(factura: any) {
  const { items, ...datosFactura } = factura;

  const { error: errorFactura } = await supabase
    .from("facturas")
    .upsert(datosFactura, { onConflict: "cufe" });
  if (errorFactura) throw errorFactura;

  if (items.length > 0) {
    await supabase.from("factura_items").delete().eq("factura_cufe", factura.cufe);
    const itemsConCufe = items.map((it: any) => ({ ...it, factura_cufe: factura.cufe }));
    const { error: errorItems } = await supabase.from("factura_items").insert(itemsConCufe);
    if (errorItems) throw errorItems;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { url } = await req.json();
    if (!url || typeof url !== "string") {
      return new Response(JSON.stringify({ error: "Falta el parámetro url" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const factura = await scrapeFactura(url);

    if (!factura.cufe) {
      return new Response(
        JSON.stringify({ error: "No se pudo extraer el CUFE de la página", factura }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    await guardarEnSupabase(factura);

    return new Response(
      JSON.stringify({
        success: true,
        cufe: factura.cufe,
        emisor: factura.emisor_nombre,
        total: factura.total,
        items: factura.items.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// Esta función usa las variables de entorno que Supabase inyecta automáticamente
// en cada Edge Function (no hace falta configurarlas a mano):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as cheerio from "npm:cheerio@1.0.0";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function parseNumero(texto: string | null | undefined): number | null {
  if (!texto) return null;
  const limpio = String(texto).replace(/[^0-9.-]/g, "").trim();
  if (limpio === "") return null;
  const n = parseFloat(limpio);
  return isNaN(n) ? null : n;
}

function leerDtDd($: cheerio.CheerioAPI, contenedor: any): Record<string, string> {
  const datos: Record<string, string> = {};
  contenedor.find("dl.dl-vertical").each((_: number, dl: any) => {
    const etiqueta = $(dl).find("dt").text().replace(/\s+/g, " ").trim();
    const valor = $(dl).find("dd").text().replace(/\s+/g, " ").trim();
    if (etiqueta) datos[etiqueta] = valor;
  });
  return datos;
}

function buscarPanelPorTitulo($: cheerio.CheerioAPI, textoTitulo: string) {
  let panelEncontrado: any = null;
  $(".panel").each((_: number, panel: any) => {
    const heading = $(panel).find(".panel-heading").first().text().replace(/\s+/g, " ").trim();
    if (heading.includes(textoTitulo)) {
      panelEncontrado = $(panel);
      return false;
    }
  });
  return panelEncontrado;
}

function parseDescripcion(descripcion: string, cantidadComprada: number | null) {
  const resultado = {
    contenido_cantidad: null as number | null,
    contenido_unidad: null as string | null,
    paquete_cantidad: null as number | null,
    vendido_por_peso: false,
  };
  if (!descripcion) return resultado;

  const matchPaquete = descripcion.match(/(\d+)\s*'?\s*U\b/i);
  if (matchPaquete) resultado.paquete_cantidad = parseInt(matchPaquete[1], 10);

  const matchUnidad = descripcion.match(/(\d+(?:\.\d+)?)\s*(KG|GR|G|ML|L|MM|CM|OZ|LB)\b\.?/i);
  if (matchUnidad) {
    resultado.contenido_cantidad = parseFloat(matchUnidad[1]);
    resultado.contenido_unidad = matchUnidad[2].toUpperCase();
    return resultado;
  }

  if (/\bKG\.?\s*$/i.test(descripcion.trim())) {
    resultado.contenido_cantidad = cantidadComprada;
    resultado.contenido_unidad = "KG";
    resultado.vendido_por_peso = true;
  }

  return resultado;
}

async function scrapeFactura(url: string) {
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; QRLector/1.0)" },
  });
  const html = await resp.text();
  const $ = cheerio.load(html);

  const numeroFactura = $(".col-sm-4.text-left h5").first().text().replace(/\s+/g, " ").trim();
  const fechaEmision = $(".col-sm-4.text-right h5").first().text().replace(/\s+/g, " ").trim();

  const panelEncabezado = $(".panel-body").first();
  const datosEncabezado = leerDtDd($, panelEncabezado);

  const cufe = datosEncabezado["CÓDIGO ÚNICO DE FACTURA ELECTRÓNICA [CUFE]"] || null;
  const protocoloAutorizacion = datosEncabezado["PROTOCOLO DE AUTORIZACIÓN"] || null;
  const fechaAutorizacion = datosEncabezado["FECHA AUTORIZACIÓN"] || null;

  const panelEmisor = buscarPanelPorTitulo($, "EMISOR");
  const datosEmisor = panelEmisor ? leerDtDd($, panelEmisor) : {};

  const textoFooter = $("#detalle tfoot").text();
  const totalPagadoMatch = textoFooter.match(/TOTAL PAGADO:\s*([\d.,]+)/i);
  const descuentosGeneralesMatch = textoFooter.match(/Descuentos:\s*([\d.,]+)/i);

  const items: any[] = [];
  $("#detalle table tbody tr").each((_: number, row: any) => {
    const $row = $(row);
    const celda = (titulo: string) => $row.find(`td[data-title="${titulo}"]`).text().trim();

    const descripcion = celda("Descripción");
    if (!descripcion) return;

    const cantidadComprada = parseNumero(celda("Cantidad"));
    const { contenido_cantidad, contenido_unidad, paquete_cantidad, vendido_por_peso } =
      parseDescripcion(descripcion, cantidadComprada);

    items.push({
      linea: parseInt(celda("Linea"), 10) || null,
      codigo: celda("Código") || null,
      descripcion,
      info_interes: celda("Información de interés") || null,
      cantidad_comprada: cantidadComprada,
      contenido_cantidad,
      contenido_unidad,
      paquete_cantidad,
      vendido_por_peso,
      precio_unitario: parseNumero(celda("Precio")),
      descuento_unitario: parseNumero(celda("Descuento")) || 0,
      monto: parseNumero(celda("Monto")),
      itbms: parseNumero(celda("Impuesto")),
      total_item: parseNumero(celda("Total")),
    });
  });

  return {
    cufe,
    numero_factura: numeroFactura,
    fecha_emision: fechaEmision,
    protocolo_autorizacion: protocoloAutorizacion,
    fecha_autorizacion: fechaAutorizacion,
    emisor_ruc: datosEmisor["RUC"] || null,
    emisor_dv: datosEmisor["DV"] || null,
    emisor_nombre: datosEmisor["NOMBRE"] || null,
    emisor_direccion: datosEmisor["DIRECCIÓN"] || null,
    emisor_telefono: datosEmisor["TELÉFONO"] || null,
    total: totalPagadoMatch ? parseNumero(totalPagadoMatch[1]) : null,
    descuentos_generales: descuentosGeneralesMatch ? parseNumero(descuentosGeneralesMatch[1]) : 0,
    url_origen: url,
    items,
  };
}

async function guardarEnSupabase(factura: any) {
  const { items, ...datosFactura } = factura;

  const { error: errorFactura } = await supabase
    .from("facturas")
    .upsert(datosFactura, { onConflict: "cufe" });
  if (errorFactura) throw errorFactura;

  if (items.length > 0) {
    await supabase.from("factura_items").delete().eq("factura_cufe", factura.cufe);
    const itemsConCufe = items.map((it: any) => ({ ...it, factura_cufe: factura.cufe }));
    const { error: errorItems } = await supabase.from("factura_items").insert(itemsConCufe);
    if (errorItems) throw errorItems;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { url } = await req.json();
    if (!url || typeof url !== "string") {
      return new Response(JSON.stringify({ error: "Falta el parámetro url" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const factura = await scrapeFactura(url);

    if (!factura.cufe) {
      return new Response(
        JSON.stringify({ error: "No se pudo extraer el CUFE de la página", factura }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    await guardarEnSupabase(factura);

    return new Response(
      JSON.stringify({
        success: true,
        cufe: factura.cufe,
        emisor: factura.emisor_nombre,
        total: factura.total,
        items: factura.items.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
