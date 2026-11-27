/**
 * Gerador e leitor nativo de planilhas Excel OpenXML (.xlsx) com células formatadas
 * na identidade visual verde do Sistema SSMA 2.0, sem dependências externas pesadas.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8')

/* ─────────────────── CRC32 & ZIP (OpenXML Container) ─────────────────── */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function writeU16(view, offset, val) {
  view.setUint16(offset, val & 0xffff, true)
}

function writeU32(view, offset, val) {
  view.setUint32(offset, val >>> 0, true)
}

export function createZipArchive(files) {
  const localParts = []
  const centralParts = []
  let localOffset = 0

  for (const file of files) {
    const nameBytes = encoder.encode(file.name)
    const content = file.data instanceof Uint8Array ? file.data : encoder.encode(file.data)
    const crc = crc32(content)
    const size = content.length

    const localHeader = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(localHeader.buffer)
    writeU32(lv, 0, 0x04034b50)
    writeU16(lv, 4, 20)
    writeU16(lv, 6, 0x0800) // UTF-8 filename flag
    writeU16(lv, 8, 0) // Store (uncompressed, instant & universal in Excel/Calc/Sheets)
    writeU16(lv, 10, 0)
    writeU16(lv, 12, 0x21)
    writeU32(lv, 14, crc)
    writeU32(lv, 18, size)
    writeU32(lv, 22, size)
    writeU16(lv, 26, nameBytes.length)
    writeU16(lv, 28, 0)
    localHeader.set(nameBytes, 30)

    localParts.push(localHeader, content)

    const centralHeader = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(centralHeader.buffer)
    writeU32(cv, 0, 0x02014b50)
    writeU16(cv, 4, 20)
    writeU16(cv, 6, 20)
    writeU16(cv, 8, 0x0800)
    writeU16(cv, 10, 0)
    writeU16(cv, 12, 0)
    writeU16(cv, 14, 0x21)
    writeU32(cv, 16, crc)
    writeU32(cv, 20, size)
    writeU32(cv, 24, size)
    writeU16(cv, 28, nameBytes.length)
    writeU16(cv, 30, 0)
    writeU16(cv, 32, 0)
    writeU16(cv, 34, 0)
    writeU16(cv, 36, 0)
    writeU32(cv, 38, 0)
    writeU32(cv, 42, localOffset)
    centralHeader.set(nameBytes, 46)

    centralParts.push(centralHeader)
    localOffset += localHeader.length + size
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  writeU32(ev, 0, 0x06054b50)
  writeU16(ev, 4, 0)
  writeU16(ev, 6, 0)
  writeU16(ev, 8, files.length)
  writeU16(ev, 10, files.length)
  writeU32(ev, 12, centralSize)
  writeU32(ev, 16, localOffset)
  writeU16(ev, 20, 0)

  const total = localOffset + centralSize + 22
  const out = new Uint8Array(total)
  let pos = 0
  for (const p of [...localParts, ...centralParts, eocd]) {
    out.set(p, pos)
    pos += p.length
  }
  return out
}

async function inflateRaw(compressed) {
  if (typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('deflate-raw')
    const writer = ds.writable.getWriter()
    writer.write(compressed)
    writer.close()
    const chunks = []
    const reader = ds.readable.getReader()
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.length
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      out.set(c, offset)
      offset += c.length
    }
    return out
  }
  throw new Error('Descompactação nativa indisponível neste ambiente.')
}

async function readZipEntries(arrayBuffer) {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  let eocdOffset = -1
  const minSearch = Math.max(0, bytes.length - 65558)
  for (let i = bytes.length - 22; i >= minSearch; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset < 0) throw new Error('Arquivo inválido. Envie uma planilha Excel (.xlsx) ou CSV.')

  const entryCount = view.getUint16(eocdOffset + 10, true)
  let cdPos = view.getUint32(eocdOffset + 16, true)
  const entries = new Map()

  for (let i = 0; i < entryCount && cdPos + 46 <= bytes.length; i++) {
    if (view.getUint32(cdPos, true) !== 0x02014b50) break
    const method = view.getUint16(cdPos + 10, true)
    const compSize = view.getUint32(cdPos + 20, true)
    const nameLen = view.getUint16(cdPos + 28, true)
    const extraLen = view.getUint16(cdPos + 30, true)
    const commentLen = view.getUint16(cdPos + 32, true)
    const localOffset = view.getUint32(cdPos + 42, true)
    const name = decoder.decode(bytes.subarray(cdPos + 46, cdPos + 46 + nameLen))

    const localNameLen = view.getUint16(localOffset + 26, true)
    const localExtraLen = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const rawSlice = bytes.subarray(dataStart, dataStart + compSize)

    let contentBytes
    if (method === 0) contentBytes = rawSlice
    else if (method === 8) contentBytes = await inflateRaw(rawSlice)
    else throw new Error('Método de compressão da planilha não suportado.')

    entries.set(name.replace(/^\/+/, ''), contentBytes)
    cdPos += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/* ─────────────────── OpenXML Styled Workbook Builder (Identidade Verde) ─────────────────── */
function escXml(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r\n|\r/g, '\n')
}

export function colName(index) {
  let n = index + 1
  let s = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/**
 * Índices de estilo (cellXfs):
 * 0: Padrão
 * 1: Banner Título Principal (Fundo Verde Escuro #14532D, Fonte Branca Negrito 13pt)
 * 2: Subtítulo / Faixa Institucional (Fundo Verde Suave #DCFCE7, Texto Verde Escuro #14532D 10pt)
 * 3: Cabeçalho da Tabela (Fundo Verde Identidade #15803D, Fonte Branca Negrito 11pt, Bordas)
 * 4: Texto Par (Fundo Branco, Borda Verde Clara)
 * 5: Texto Ímpar Zebra (Fundo #F0FDF4, Borda Verde Clara)
 * 6: Moeda R$ Par ("R$" #,##0.00)
 * 7: Moeda R$ Ímpar Zebra ("R$" #,##0.00)
 * 8: Inteiro Centralizado Par (#,##0)
 * 9: Inteiro Centralizado Ímpar Zebra (#,##0)
 * 10: Código/CA Texto Centralizado Par (@)
 * 11: Código/CA Texto Centralizado Ímpar Zebra (@)
 * 12: Linha de Total (Fundo #BBF7D0, Negrito, Moeda/Número)
 */
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2">
    <numFmt numFmtId="164" formatCode="&quot;R$&quot;\\ #,##0.00"/>
    <numFmt numFmtId="165" formatCode="#,##0"/>
  </numFmts>
  <fonts count="5">
    <font><sz val="10"/><color rgb="FF0F172A"/><name val="Calibri"/></font>
    <font><b/><sz val="13"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
    <font><b/><sz val="10"/><color rgb="FF14532D"/><name val="Calibri"/></font>
    <font><b/><sz val="10.5"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
    <font><b/><sz val="10.5"/><color rgb="FF14532D"/><name val="Calibri"/></font>
  </fonts>
  <fills count="7">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF14532D"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF15803D"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF0FDF4"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFBBF7D0"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="3">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFBBF7D0"/></left>
      <right style="thin"><color rgb="FFBBF7D0"/></right>
      <top style="thin"><color rgb="FFBBF7D0"/></top>
      <bottom style="thin"><color rgb="FFBBF7D0"/></bottom>
      <diagonal/>
    </border>
    <border>
      <left style="thin"><color rgb="FF166534"/></left>
      <right style="thin"><color rgb="FF166534"/></right>
      <top style="medium"><color rgb="FF14532D"/></top>
      <bottom style="medium"><color rgb="FF14532D"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="14">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" horizontal="left" indent="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" horizontal="left" indent="1" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="4" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" horizontal="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" horizontal="left" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" horizontal="left" wrapText="1"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" horizontal="right"/></xf>
    <xf numFmtId="164" fontId="0" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" horizontal="right"/></xf>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" horizontal="center"/></xf>
    <xf numFmtId="165" fontId="0" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" horizontal="center"/></xf>
    <xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" horizontal="center"/></xf>
    <xf numFmtId="49" fontId="0" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" horizontal="center"/></xf>
    <xf numFmtId="165" fontId="4" fillId="6" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" horizontal="center"/></xf>
    <xf numFmtId="164" fontId="4" fillId="6" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" horizontal="right"/></xf>
  </cellXfs>
  <cellStyles count="1">
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
</styleSheet>`

function buildWorksheetXml(sheet) {
  const { title, subtitle, columns, rows, emptyFormattedRows = 0, showAutoFilter = true } = sheet
  const colCount = columns.length
  const lastCol = colName(colCount - 1)
  const colsXml = columns
    .map((c, idx) => `<col min="${idx + 1}" max="${idx + 1}" width="${c.width || 18}" customWidth="1"/>`)
    .join('')

  const xmlRows = []

  // Linha 1: Banner Verde Escuro
  const bannerCells = columns
    .map((_, cIdx) => {
      const ref = `${colName(cIdx)}1`
      return cIdx === 0
        ? `<c r="${ref}" s="1" t="inlineStr"><is><t>${escXml(title)}</t></is></c>`
        : `<c r="${ref}" s="1"/>`
    })
    .join('')
  xmlRows.push(`<row r="1" ht="30" customHeight="1">${bannerCells}</row>`)

  // Linha 2: Subtítulo Verde Suave
  const subCells = columns
    .map((_, cIdx) => {
      const ref = `${colName(cIdx)}2`
      return cIdx === 0
        ? `<c r="${ref}" s="2" t="inlineStr"><is><t>${escXml(subtitle || '')}</t></is></c>`
        : `<c r="${ref}" s="2"/>`
    })
    .join('')
  xmlRows.push(`<row r="2" ht="22" customHeight="1">${subCells}</row>`)

  // Linha 3: Cabeçalhos das colunas na cor verde (#15803D)
  const headerCells = columns
    .map((col, cIdx) => `<c r="${colName(cIdx)}3" s="3" t="inlineStr"><is><t>${escXml(col.header)}</t></is></c>`)
    .join('')
  xmlRows.push(`<row r="3" ht="26" customHeight="1">${headerCells}</row>`)

  // Linhas de dados (a partir da linha 4)
  const totalRowCount = Math.max(rows.length, emptyFormattedRows)
  for (let rIdx = 0; rIdx < totalRowCount; rIdx++) {
    const excelRow = rIdx + 4
    const odd = rIdx % 2 === 1
    const rowData = rows[rIdx] || []
    const isTotalRow = rowData.__isTotal === true
    const cells = columns
      .map((col, cIdx) => {
        const ref = `${colName(cIdx)}${excelRow}`
        const val = Array.isArray(rowData) ? rowData[cIdx] : rowData[col.key]
        const type = col.type || 'text'
        const style = isTotalRow
          ? type === 'currency'
            ? 13
            : 12
          : type === 'currency'
            ? odd
              ? 7
              : 6
            : type === 'integer'
              ? odd
                ? 9
                : 8
              : type === 'code'
                ? odd
                  ? 11
                  : 10
                : odd
                  ? 5
                  : 4

        if (val === null || val === undefined || val === '') {
          return `<c r="${ref}" s="${style}"/>`
        }
        if ((type === 'currency' || type === 'integer') && typeof val === 'number' && Number.isFinite(val)) {
          return `<c r="${ref}" s="${style}" t="n"><v>${val}</v></c>`
        }
        return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escXml(val)}</t></is></c>`
      })
      .join('')
    xmlRows.push(`<row r="${excelRow}" ht="21" customHeight="1">${cells}</row>`)
  }

  const lastDataRow = Math.max(4, 3 + totalRowCount)
  const filterXml = showAutoFilter ? `<autoFilter ref="A3:${lastCol}${lastDataRow}"/>` : ''

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView workbookViewId="0">
      <pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="20"/>
  <cols>${colsXml}</cols>
  <sheetData>${xmlRows.join('')}</sheetData>
  ${filterXml}
  <mergeCells count="2">
    <mergeCell ref="A1:${lastCol}1"/>
    <mergeCell ref="A2:${lastCol}2"/>
  </mergeCells>
</worksheet>`
}

export function buildGreenWorkbook(sheets) {
  const safeSheets = sheets.map((s, idx) => ({
    ...s,
    sheetName: String(s.sheetName || `Planilha${idx + 1}`).replace(/[\\/?*[\]:]/g, '').slice(0, 31),
  }))

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${safeSheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('\n  ')}
</Types>`

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${safeSheets
      .map((s, i) => `<sheet name="${escXml(s.sheetName)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('\n    ')}
  </sheets>
</workbook>`

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${safeSheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join('\n  ')}
  <Relationship Id="rId${safeSheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

  const files = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: STYLES_XML },
    ...safeSheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: buildWorksheetXml(s),
    })),
  ]

  return createZipArchive(files)
}

export function triggerXlsxDownload(bytes, filename) {
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename.endsWith('.xlsx') ? filename : filename + '.xlsx'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

/* ─────────────────── Template de Estoque & Exportação Consolidada ─────────────────── */
export const STOCK_TEMPLATE_COLUMNS = [
  { key: 'name', header: 'Nome do material', width: 36, type: 'text' },
  { key: 'ca', header: 'CA principal', width: 16, type: 'code' },
  { key: 'generic1', header: 'CA genérico 1', width: 16, type: 'code' },
  { key: 'generic2', header: 'CA genérico 2', width: 16, type: 'code' },
  { key: 'generic3', header: 'CA genérico 3', width: 16, type: 'code' },
  { key: 'price', header: 'Valor unitário (R$)', width: 20, type: 'currency' },
  { key: 'qty', header: 'Quantidade', width: 15, type: 'integer' },
  { key: 'minimum', header: 'Quantidade mínima', width: 19, type: 'integer' },
  { key: 'size', header: 'Tamanho / numeração', width: 22, type: 'code' },
  { key: 'color', header: 'Cor', width: 18, type: 'text' },
]

export function buildStockTemplateBytes(existingMaterials = []) {
  const prefilled = existingMaterials.map((m) => ({
    name: m.name || '',
    ca: m.no_ca ? 'Sem CA' : m.ca || '',
    generic1: m.generic_cas?.[0] || '',
    generic2: m.generic_cas?.[1] || '',
    generic3: m.generic_cas?.[2] || '',
    price: Number(m.price || 0),
    qty: Number(m.qty || 0),
    minimum: Number(m.minimum || 0),
    size: m.size || '',
    color: m.color || '',
  }))

  return buildGreenWorkbook([
    {
      sheetName: 'Estoque',
      title: 'SISTEMA SSMA 2.0 — TEMPLATE OFICIAL DE IMPORTAÇÃO E ATUALIZAÇÃO DE ESTOQUE',
      subtitle:
        'Preencha a partir da linha 4. Itens já existentes no seu estoque são atualizados sem duplicar; novos itens são cadastrados automaticamente.',
      columns: STOCK_TEMPLATE_COLUMNS,
      rows: prefilled,
      emptyFormattedRows: Math.max(25, prefilled.length + 10),
    },
    {
      sheetName: 'Instruções e Exemplos',
      title: 'GUIA DE PREENCHIMENTO — IMPORTAÇÃO DE ESTOQUE SSMA 2.0',
      subtitle: 'Esta aba é apenas informativa (somente a aba "Estoque" é importada).',
      columns: STOCK_TEMPLATE_COLUMNS,
      rows: [
        {
          name: 'BOTINA DE SEGURANÇA BIQUEIRA COMPOSITE',
          ca: '43210',
          generic1: '43211',
          generic2: '',
          generic3: '',
          price: 129.9,
          qty: 20,
          minimum: 8,
          size: '40',
          color: 'Preto',
        },
        {
          name: 'ÓCULOS DE PROTEÇÃO INCOLOR',
          ca: '11268',
          generic1: '',
          generic2: '',
          generic3: '',
          price: 14.5,
          qty: 50,
          minimum: 15,
          size: 'Único',
          color: 'Incolor',
        },
        {
          name: 'BOLSA DE LONA PARA FERRAMENTAS',
          ca: 'Sem CA',
          generic1: '',
          generic2: '',
          generic3: '',
          price: 85.0,
          qty: 10,
          minimum: 4,
          size: '',
          color: 'Verde',
        },
      ],
      showAutoFilter: false,
    },
  ])
}

export const CONSOLIDATED_EXPORT_COLUMNS = [
  { key: 'material', header: 'Material', width: 38, type: 'text' },
  { key: 'ca', header: 'CA Principal', width: 16, type: 'code' },
  { key: 'generics', header: 'CA Genérico', width: 24, type: 'code' },
  { key: 'region', header: 'Região', width: 20, type: 'text' },
  { key: 'qty', header: 'Quantidade', width: 16, type: 'integer' },
]

export const DISTRIBUTION_EXPORT_COLUMNS = [
  { key: 'material', header: 'Material', width: 38, type: 'text' },
  { key: 'ca', header: 'CA Principal', width: 16, type: 'code' },
  { key: 'generics', header: 'CA Genérico', width: 24, type: 'code' },
  { key: 'qty', header: 'Quantidade', width: 16, type: 'integer' },
  { key: 'project', header: 'Projeto', width: 28, type: 'text' },
  { key: 'region', header: 'Região', width: 20, type: 'text' },
]

const exportStamp = () => new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })

export function buildConsolidatedStockBytes(consolidatedRows, distributionRows = []) {
  const totalQty = consolidatedRows.reduce((s, r) => s + Number(r.qty || 0), 0)
  const sheets = [
    {
      sheetName: 'Estoque Consolidado',
      title: 'SISTEMA SSMA 2.0 — RELATÓRIO DE ESTOQUE CONSOLIDADO',
      subtitle: `Exportado em ${exportStamp()} · ${consolidatedRows.length} material(is) · ${totalQty.toLocaleString('pt-BR')} item(ns) no total`,
      columns: CONSOLIDATED_EXPORT_COLUMNS,
      rows: [
        ...consolidatedRows,
        { material: 'TOTAL GERAL DE ITENS', ca: '', generics: '', region: '', qty: totalQty, __isTotal: true },
      ],
    },
  ]
  if (distributionRows.length > 0) {
    sheets.push({
      sheetName: 'Distribuição Projeto Região',
      title: 'SISTEMA SSMA 2.0 — DISTRIBUIÇÃO ENTREGUE POR PROJETO E REGIÃO',
      subtitle: 'Quantidades acumuladas entregues aos projetos por macrorregião.',
      columns: DISTRIBUTION_EXPORT_COLUMNS,
      rows: distributionRows,
    })
  }
  return buildGreenWorkbook(sheets)
}

/**
 * Exportação consolidada dos itens enviados (Valor entregue por projeto e região) em um período.
 * rows: [{ project, region, state, material, ca, qty, cents }]
 */
export function buildDeliveredPeriodBytes(rows, { start = '', end = '' } = {}) {
  const fmt = (d) => (d ? d.split('-').reverse().join('/') : '')
  const periodLabel = start || end ? `Período: ${fmt(start) || 'início'} a ${fmt(end) || 'hoje'}` : 'Período: todo o histórico'
  const money = (c) => Math.round(c) / 100
  const sorted = [...rows].sort(
    (a, b) =>
      String(a.project).localeCompare(String(b.project), 'pt-BR') ||
      String(a.material).localeCompare(String(b.material), 'pt-BR'),
  )
  const totalQty = rows.reduce((s, r) => s + r.qty, 0)
  const totalCents = rows.reduce((s, r) => s + r.cents, 0)

  const group = (keyFn) => {
    const map = new Map()
    for (const r of rows) {
      const k = keyFn(r) || 'Sem informação'
      const g = map.get(k) || { label: k, qty: 0, cents: 0, materials: new Set() }
      g.qty += r.qty
      g.cents += r.cents
      g.materials.add(r.material)
      map.set(k, g)
    }
    return [...map.values()].sort((a, b) => b.cents - a.cents)
  }

  const summaryColumns = (label) => [
    { key: 'label', header: label, width: 32, type: 'text' },
    { key: 'materials', header: 'Materiais distintos', width: 20, type: 'integer' },
    { key: 'qty', header: 'Quantidade enviada', width: 20, type: 'integer' },
    { key: 'total', header: 'Valor total (R$)', width: 20, type: 'currency' },
  ]
  const summaryRows = (list, totalLabel) => [
    ...list.map((g) => ({ label: g.label, materials: g.materials.size, qty: g.qty, total: money(g.cents) })),
    { label: totalLabel, materials: '', qty: totalQty, total: money(totalCents), __isTotal: true },
  ]

  return buildGreenWorkbook([
    {
      sheetName: 'Itens enviados',
      title: 'SISTEMA SSMA 2.0 — ITENS ENVIADOS POR PROJETO E REGIÃO (CONSOLIDADO)',
      subtitle: `${periodLabel} · Exportado em ${exportStamp()}`,
      columns: [
        { key: 'project', header: 'Projeto', width: 26, type: 'text' },
        { key: 'region', header: 'Região', width: 16, type: 'text' },
        { key: 'state', header: 'UF', width: 8, type: 'code' },
        { key: 'material', header: 'Material', width: 40, type: 'text' },
        { key: 'ca', header: 'CA', width: 12, type: 'code' },
        { key: 'qty', header: 'Quantidade', width: 14, type: 'integer' },
        { key: 'unit', header: 'Valor unitário médio (R$)', width: 22, type: 'currency' },
        { key: 'total', header: 'Valor total (R$)', width: 18, type: 'currency' },
      ],
      rows: [
        ...sorted.map((r) => ({
          project: r.project,
          region: r.region,
          state: r.state,
          material: r.material,
          ca: r.ca,
          qty: r.qty,
          unit: r.qty ? money(r.cents / r.qty) : 0,
          total: money(r.cents),
        })),
        { project: 'TOTAL GERAL', region: '', state: '', material: '', ca: '', qty: totalQty, unit: '', total: money(totalCents), __isTotal: true },
      ],
    },
    {
      sheetName: 'Por projeto',
      title: 'SISTEMA SSMA 2.0 — TOTAL ENVIADO POR PROJETO',
      subtitle: periodLabel,
      columns: summaryColumns('Projeto'),
      rows: summaryRows(group((r) => r.project), 'TOTAL GERAL'),
      showAutoFilter: false,
    },
    {
      sheetName: 'Por região',
      title: 'SISTEMA SSMA 2.0 — TOTAL ENVIADO POR REGIÃO',
      subtitle: periodLabel,
      columns: summaryColumns('Região'),
      rows: summaryRows(group((r) => r.region), 'TOTAL GERAL'),
      showAutoFilter: false,
    },
  ])
}

/* ─────────────────── Leitor Universal (.xlsx e .csv) para Importação ─────────────────── */
function unescapeXml(str) {
  return String(str || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
}

function colRefToIndex(cellRef) {
  const letters = String(cellRef || '').replace(/[0-9$]/g, '').toUpperCase()
  let idx = 0
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64)
  }
  return Math.max(0, idx - 1)
}

function parseSharedStrings(xml) {
  if (!xml) return []
  const list = []
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  let match
  while ((match = siRegex.exec(xml)) !== null) {
    const inner = match[1]
    const texts = []
    const tRegex = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g
    let tm
    while ((tm = tRegex.exec(inner)) !== null) texts.push(unescapeXml(tm[1]))
    list.push(texts.join(''))
  }
  return list
}

function parseSheetMatrix(sheetXml, sharedStrings) {
  const matrix = []
  const rowRegex = /<row\b([^>]*)>([\s\S]*?)<\/row>/g
  let rm
  while ((rm = rowRegex.exec(sheetXml)) !== null) {
    const rowAttrs = rm[1]
    const rowInner = rm[2]
    const rAttr = /\br="(\d+)"/.exec(rowAttrs)
    const excelRowNumber = rAttr ? Number(rAttr[1]) : matrix.length + 1
    const rowValues = []
    const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    let cm
    let autoCol = 0
    while ((cm = cellRegex.exec(rowInner)) !== null) {
      const attrs = cm[1]
      const body = cm[2] || ''
      const refMatch = /\br="([A-Z]+\d+)"/i.exec(attrs)
      const cIdx = refMatch ? colRefToIndex(refMatch[1]) : autoCol
      autoCol = cIdx + 1
      const typeMatch = /\bt="([^"]+)"/.exec(attrs)
      const cType = typeMatch ? typeMatch[1] : 'n'

      let value = ''
      if (cType === 'inlineStr') {
        const texts = []
        const tRegex = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g
        let tm
        while ((tm = tRegex.exec(body)) !== null) texts.push(unescapeXml(tm[1]))
        value = texts.join('')
      } else {
        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)
        const rawVal = vMatch ? unescapeXml(vMatch[1]) : ''
        if (cType === 's') {
          value = sharedStrings[Number(rawVal)] ?? ''
        } else if (cType === 'b') {
          value = rawVal === '1' ? 'Sim' : 'Não'
        } else {
          value = rawVal
        }
      }
      rowValues[cIdx] = value
    }
    matrix.push({ excelRowNumber, values: rowValues })
  }
  return matrix
}

function parseCsvMatrix(text) {
  const clean = text.replace(/^\uFEFF/, '')
  const lines = clean.split(/\r\n|\n|\r/)
  const firstNonEmpty = lines.find((l) => l.trim().length > 0) || ''
  const sep = (firstNonEmpty.match(/;/g) || []).length >= (firstNonEmpty.match(/,/g) || []).length ? ';' : ','

  return lines.map((line, i) => {
    const values = []
    let cur = ''
    let inQuotes = false
    for (let c = 0; c < line.length; c++) {
      const ch = line[c]
      if (ch === '"') {
        if (inQuotes && line[c + 1] === '"') {
          cur += '"'
          c++
        } else {
          inQuotes = !inQuotes
        }
      } else if (ch === sep && !inQuotes) {
        values.push(cur.trim())
        cur = ''
      } else {
        cur += ch
      }
    }
    values.push(cur.trim())
    return { excelRowNumber: i + 1, values }
  })
}

function normalizeHeader(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

const HEADER_ALIASES = {
  name: ['nomedomaterial', 'material', 'nome', 'descricao', 'equipamento', 'epi'],
  ca: ['caprincipal', 'ca', 'numerodoca', 'certificado'],
  generic1: ['cagenerico1', 'generico1', 'caalternativo1'],
  generic2: ['cagenerico2', 'generico2', 'caalternativo2'],
  generic3: ['cagenerico3', 'generico3', 'caalternativo3'],
  price: ['valorunitarior', 'valorunitario', 'preco', 'valor', 'custounitario', 'precounitario'],
  qty: ['quantidade', 'qtd', 'saldo', 'estoque', 'quantidadedisponivel'],
  minimum: ['quantidademinima', 'minimo', 'estoqueminimo', 'qtdminima'],
  size: ['tamanhonumeracao', 'tamanho', 'numeracao', 'grade', 'tam'],
  color: ['cor', 'tonalidade'],
}

export function parseMoneyCell(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.round(raw * 100) / 100
  const str = String(raw ?? '').trim()
  if (!str) return 0
  const cleaned = str.replace(/[R$\s\u00A0]/gi, '')
  if (!cleaned) return 0
  let normalized = cleaned
  if (cleaned.includes(',') && cleaned.includes('.')) {
    normalized =
      cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
        ? cleaned.replace(/\./g, '').replace(',', '.')
        : cleaned.replace(/,/g, '')
  } else if (cleaned.includes(',')) {
    normalized = cleaned.replace(',', '.')
  }
  const n = Number(normalized)
  if (!Number.isFinite(n) || n < 0) return NaN
  return Math.round(n * 100) / 100
}

export function parseIntCell(raw, fallback = 0) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.round(raw)
  const str = String(raw ?? '').trim()
  if (!str) return fallback
  const normalized = str.replace(/\./g, '').replace(',', '.')
  const n = Number(normalized)
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(Math.round(n * 1000) / 1000)) return NaN
  return Math.round(n)
}

function cleanCaValue(raw) {
  const str = String(raw ?? '').trim()
  if (!str) return { no_ca: true, ca: '' }
  const lower = str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
  if (['sem ca', 's/ca', 'sca', 'nao possui', 'isento', '-', '—', 'n/a', 'na'].includes(lower)) {
    return { no_ca: true, ca: '' }
  }
  const digits = str.replace(/\.0+$/, '').replace(/\D/g, '')
  return { no_ca: false, ca: digits, raw: str }
}

export async function parseStockSpreadsheet(input, fileName = 'planilha.xlsx') {
  const bytes =
    input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(await input.arrayBuffer())

  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
  let matrix = []

  if (isZip || fileName.toLowerCase().endsWith('.xlsx')) {
    const entries = await readZipEntries(bytes)
    const sharedXml = entries.has('xl/sharedStrings.xml')
      ? decoder.decode(entries.get('xl/sharedStrings.xml'))
      : ''
    const shared = parseSharedStrings(sharedXml)
    const sheetEntry =
      entries.get('xl/worksheets/sheet1.xml') ||
      [...entries.entries()].find(([k]) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))?.[1]
    if (!sheetEntry) throw new Error('Nenhuma aba de dados foi encontrada na planilha .xlsx.')
    matrix = parseSheetMatrix(decoder.decode(sheetEntry), shared)
  } else {
    matrix = parseCsvMatrix(decoder.decode(bytes))
  }

  // Localiza automaticamente a linha de cabeçalho (ex.: linha 3 do nosso template ou linha 1 de outra planilha)
  let headerRowIdx = -1
  let columnMap = {}
  for (let i = 0; i < Math.min(matrix.length, 15); i++) {
    const normalizedCells = (matrix[i].values || []).map(normalizeHeader)
    const candidate = {}
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      const idx = normalizedCells.findIndex((cell) => aliases.includes(cell))
      if (idx >= 0) candidate[field] = idx
    }
    if (candidate.name !== undefined && (candidate.ca !== undefined || candidate.qty !== undefined)) {
      headerRowIdx = i
      columnMap = candidate
      break
    }
  }

  if (headerRowIdx < 0) {
    throw new Error(
      'Cabeçalho não reconhecido. Utilize o botão "Baixar template (.xlsx)" com as colunas: Nome do material, CA principal, CA genérico 1..3, Valor unitário (R$), Quantidade, Quantidade mínima, Tamanho / numeração e Cor.',
    )
  }

  const validRows = []
  const preValidationErrors = []

  for (let i = headerRowIdx + 1; i < matrix.length; i++) {
    const { excelRowNumber, values } = matrix[i]
    const get = (field) => (columnMap[field] !== undefined ? values[columnMap[field]] ?? '' : '')
    const rawAll = [
      get('name'),
      get('ca'),
      get('generic1'),
      get('generic2'),
      get('generic3'),
      get('price'),
      get('qty'),
      get('minimum'),
      get('size'),
      get('color'),
    ]
    if (rawAll.every((v) => String(v ?? '').trim() === '')) continue

    const name = String(get('name') ?? '').trim()
    if (!name) {
      preValidationErrors.push({
        line: excelRowNumber,
        material: '(Sem nome)',
        status: 'error',
        detail: 'Nome do material está em branco.',
      })
      continue
    }
    if (name.length > 200) {
      preValidationErrors.push({
        line: excelRowNumber,
        material: name.slice(0, 60),
        status: 'error',
        detail: 'Nome do material excede 200 caracteres.',
      })
      continue
    }

    const caParsed = cleanCaValue(get('ca'))
    if (!caParsed.no_ca && !caParsed.ca) {
      preValidationErrors.push({
        line: excelRowNumber,
        material: name,
        status: 'error',
        detail: `CA principal inválido ("${caParsed.raw}"). Informe apenas números ou "Sem CA".`,
      })
      continue
    }

    const generics = []
    let genericInvalid = ''
    for (const gKey of ['generic1', 'generic2', 'generic3']) {
      const gRaw = String(get(gKey) ?? '').trim()
      if (!gRaw || /^(-|—|sem ca|s\/ca)$/i.test(gRaw)) continue
      const gDigits = gRaw.replace(/\.0+$/, '').replace(/\D/g, '')
      if (!gDigits) {
        genericInvalid = `CA genérico inválido ("${gRaw}").`
        break
      }
      if (!caParsed.no_ca && gDigits.replace(/^0+/, '') !== caParsed.ca.replace(/^0+/, '')) {
        if (!generics.some((x) => x.replace(/^0+/, '') === gDigits.replace(/^0+/, ''))) {
          generics.push(gDigits)
        }
      }
    }
    if (genericInvalid) {
      preValidationErrors.push({
        line: excelRowNumber,
        material: name,
        status: 'error',
        detail: genericInvalid,
      })
      continue
    }

    const price = parseMoneyCell(get('price'))
    if (Number.isNaN(price)) {
      preValidationErrors.push({
        line: excelRowNumber,
        material: name,
        status: 'error',
        detail: `Valor unitário inválido ("${get('price')}").`,
      })
      continue
    }

    const qty = parseIntCell(get('qty'), 0)
    if (Number.isNaN(qty)) {
      preValidationErrors.push({
        line: excelRowNumber,
        material: name,
        status: 'error',
        detail: `Quantidade inválida ("${get('qty')}"). Informe um número inteiro maior ou igual a zero.`,
      })
      continue
    }

    const minimum = parseIntCell(get('minimum'), 0)
    if (Number.isNaN(minimum)) {
      preValidationErrors.push({
        line: excelRowNumber,
        material: name,
        status: 'error',
        detail: `Quantidade mínima inválida ("${get('minimum')}").`,
      })
      continue
    }

    const size = String(get('size') ?? '')
      .replace(/\.0+$/, '')
      .trim()
      .slice(0, 60)
    const color = String(get('color') ?? '').trim().slice(0, 60)

    validRows.push({
      line: excelRowNumber,
      name,
      ca: caParsed.no_ca ? '' : caParsed.ca,
      no_ca: caParsed.no_ca,
      generic_cas: caParsed.no_ca ? [] : generics,
      price,
      qty,
      minimum,
      size,
      color,
    })
  }

  return {
    fileName,
    byteSize: bytes.byteLength,
    rows: validRows,
    preErrors: preValidationErrors,
    totalRead: validRows.length + preValidationErrors.length,
  }
}
