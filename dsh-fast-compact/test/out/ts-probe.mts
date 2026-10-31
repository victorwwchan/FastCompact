export interface ProbeOpts {
  top?: number;
}

export function probe(x: string, o: ProbeOpts = {}): number {
  return x.length + (o.top ?? 0);
}

console.log('mts ok', probe('abc'));
