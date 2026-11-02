"use client";

export function DocumentTree({ files, selected, onOpen, disabled, prefix = '' }: {
  files: string[]; selected: string; onOpen: (path: string) => void; disabled: boolean; prefix?: string;
}) {
  const children = files.filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length));
  const folders = [...new Set(children.filter(path => path.includes('/')).map(path => path.split('/')[0]))].sort();
  return <div className={prefix ? 'ml-3 border-l pl-2' : ''}>
    {folders.map(folder => <details key={folder} open={!prefix}><summary className="cursor-pointer py-1 text-xs">{folder}</summary>
      <DocumentTree files={files} selected={selected} onOpen={onOpen} disabled={disabled} prefix={`${prefix}${folder}/`} />
    </details>)}
    {children.filter(path => !path.includes('/')).sort().map(name => <button key={name} type="button" disabled={disabled}
      className={`block w-full break-all rounded p-2 text-left text-xs hover:bg-muted ${selected === prefix + name ? 'bg-muted' : ''}`}
      onClick={() => onOpen(prefix + name)}>{name}</button>)}
  </div>;
}
