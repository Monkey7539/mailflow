// Attachment file extensions by risk tier, for the download warning in attachmentRisk.js.
//
// A bundled copy of backend/src/services/attachmentExtensions.js, which is canonical and which
// antispam also reads: the frontend image flattens frontend/ into /app and cannot import from
// backend/src. Change both. backend/src/services/attachmentExtensions.test.js fails CI when they
// differ, and it loads this file without frontend/node_modules, so keep it free of imports.
//
//   BLOCK  — run code, install something or hand over the machine when opened
//   WARN   — can carry active content (macros, HTML or SVG login pages) the user has to enable or open
//   NOTICE — archives, whose contents nothing here inspects
//   DECOY  — ordinary document and media types a disguise borrows ("invoice.pdf.exe"); only these count
//            as the fake half, so a dotted date or version number in a name ("Statement 09.15.2026.html",
//            "P&L v2.1.xlsm") is not taken for one

export const BLOCK = new Set(['exe', 'scr', 'com', 'pif', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
  'msi', 'msp', 'mst', 'jar', 'hta', 'cpl', 'reg', 'lnk', 'iso', 'img', 'vhd', 'vhdx', 'dll', 'apk', 'application', 'appx',
  'sh', 'run', 'dmg', 'pkg', 'deb', 'rpm', 'chm', 'inf', 'scf', 'url', 'ade', 'adp', 'gadget', 'ws',
  'msc', 'xll', 'py', 'pyw', 'pyz', 'pyzw', 'pyc', 'pyo', 'pl', 'ksh', 'csh', 'jnlp', 'app', 'appref-ms', 'msu',
  'diagcab', 'sct', 'wsc', 'settingcontent-ms', 'search-ms', 'library-ms', 'website', 'rdp']);

export const WARN = new Set(['docm', 'xlsm', 'xlsb', 'pptm', 'xlam', 'dotm', 'xltm', 'potm', 'ppam', 'sldm', 'html', 'htm',
  'shtml', 'xhtml', 'svg', 'mht', 'mhtml', 'one', 'pub', 'rtf']);

export const NOTICE = new Set(['zip', 'rar', '7z', 'gz', 'tgz', 'tar', 'bz2', 'xz', 'z', 'cab', 'arj', 'ace', 'lz', 'lzh']);

export const DECOY = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'odp',
  'jpg', 'jpeg', 'png', 'gif', 'mp3', 'mp4', 'mov', 'avi', 'wav']);
