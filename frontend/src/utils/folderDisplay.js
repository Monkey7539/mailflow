// Display + search helpers for the move-to-folder pickers. Accounts differ in
// IMAP delimiter ('/', '.', ...), so both helpers normalize paths to '/' for
// display and matching.

export function folderDelimiter(folder) {
  return (typeof folder?.delimiter === 'string' && folder.delimiter) || '/';
}

// Muted ancestor chain shown before a folder's name ("Personal / Insurance"),
// so same-named folders under different parents stay distinguishable.
// Empty string for root-level folders.
export function folderParentLabel(folder) {
  const path = typeof folder?.path === 'string' ? folder.path : '';
  const delimiter = folderDelimiter(folder);
  const index = path.lastIndexOf(delimiter);
  if (index <= 0) return '';
  return path.slice(0, index).split(delimiter).join(' / ');
}

// Search matches the folder name or any part of its path, with the path also
// matchable in normalized "parent/child" form regardless of account delimiter.
export function folderMatchesQuery(folder, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const name = String(folder?.name ?? '').toLowerCase();
  if (name.includes(q)) return true;
  const path = String(folder?.path ?? '').toLowerCase();
  if (path.includes(q)) return true;
  return path.split(folderDelimiter(folder).toLowerCase()).join('/').includes(q);
}
