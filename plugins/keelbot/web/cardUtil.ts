// What several of KeelBot's action cards share (split out of Actions.tsx).



export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

export function parseJson<T>(body: string): T | null {
  try {
    const v = JSON.parse(body);
    return v && typeof v === "object" ? (v as T) : null;
  } catch {
    return null;
  }
}
