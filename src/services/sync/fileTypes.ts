// Logical file types we sync, mapped to (mime[], extensions[]).
// One logical type can have multiple MIMEs (rtf has two depending on
// platform) and multiple extensions (jpg → .jpg, .jpeg).
//
// All extensions are lowercase + leading dot. Compound extensions
// (.tar.gz) are not supported — the consumer extracts the segment after
// the last dot.
//
// To add a type:
//   1. Add an entry below.
//   2. Sanity-check that Connectivo's pipeline can do something useful
//      with it. (PDFs and Office docs are the well-supported set;
//      images may pass through; archives may be returned as-is.)
//   3. No schema change needed — `ALL_FILE_TYPES` is derived from the
//      keys of this registry, and the Zod enum picks them up.

export const FILE_TYPE_REGISTRY = {
  // PDF
  pdf: { mime: ['application/pdf'], extensions: ['.pdf'] },

  // Microsoft Office (modern OOXML)
  docx: {
    mime: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    extensions: ['.docx'],
  },
  pptx: {
    mime: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    extensions: ['.pptx'],
  },
  xlsx: {
    mime: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    extensions: ['.xlsx'],
  },

  // Microsoft Office (legacy binary)
  doc: { mime: ['application/msword'], extensions: ['.doc'] },
  ppt: { mime: ['application/vnd.ms-powerpoint'], extensions: ['.ppt'] },
  xls: { mime: ['application/vnd.ms-excel'], extensions: ['.xls'] },

  // OpenDocument
  odt: { mime: ['application/vnd.oasis.opendocument.text'], extensions: ['.odt'] },
  odp: { mime: ['application/vnd.oasis.opendocument.presentation'], extensions: ['.odp'] },
  ods: { mime: ['application/vnd.oasis.opendocument.spreadsheet'], extensions: ['.ods'] },

  // Other documents
  rtf: { mime: ['application/rtf', 'text/rtf'], extensions: ['.rtf'] },
  txt: { mime: ['text/plain'], extensions: ['.txt'] },
  csv: { mime: ['text/csv'], extensions: ['.csv'] },
  epub: { mime: ['application/epub+zip'], extensions: ['.epub'] },
  html: { mime: ['text/html'], extensions: ['.html', '.htm'] },

  // Raster images
  jpg: { mime: ['image/jpeg'], extensions: ['.jpg', '.jpeg'] },
  png: { mime: ['image/png'], extensions: ['.png'] },
  gif: { mime: ['image/gif'], extensions: ['.gif'] },
  webp: { mime: ['image/webp'], extensions: ['.webp'] },
  bmp: { mime: ['image/bmp'], extensions: ['.bmp'] },
  tiff: { mime: ['image/tiff'], extensions: ['.tiff', '.tif'] },

  // Vector images
  svg: { mime: ['image/svg+xml'], extensions: ['.svg'] },

  // Archives (zip, rar) are intentionally NOT in the registry. The 1-file-per-
  // Lambda model and the per-file writeback contract assume each Canvas file
  // is a self-contained document that maps 1:1 to a remediated PDF — archives
  // break that. Re-adding requires (a) confirming Connectivo's archive
  // contract and (b) deciding the writeback story (repack vs explode). See
  // docs/TODO.md → "Archive support".
} as const;

export type FileType = keyof typeof FILE_TYPE_REGISTRY;
export const ALL_FILE_TYPES = Object.keys(FILE_TYPE_REGISTRY) as [FileType, ...FileType[]];
