// the macro files of the cartridges are parsed into the main process's memory in the background (one cartridge per call, so the app stays responsive)
export async function warmMacros(list, first) {
  const paths = [first, ...list.filter(c => !first || c.path !== first.path)].filter(Boolean).map(c => c.path);
  for (const p of paths) { try { await window.api.relation.warmMacros({ cartPaths: [p] }); } catch { return; } }
}
