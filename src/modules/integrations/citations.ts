export function citationSources(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const input = value as Record<string, unknown>;
  const fields = ['kind', 'observedAt', 'provider', 'issuedAt', 'validAt', 'fetchedAt', 'name', 'sourceId', 'sourceDate', 'importedAt', 'relationBasis', 'distanceMeters', 'downwind', 'forecastId', 'subjectType', 'condition', 'windSpeed', 'windSpeedUnit', 'windFromDegrees', 'windToDegrees'];
  return ['observations', 'weather', 'spatialContext', 'operationalContext'].flatMap(group => {
    const rows = group === 'weather' ? [input[group]] : Array.isArray(input[group]) ? input[group] : [];
    return rows.flatMap((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const row = raw as Record<string, unknown>;
      if (typeof row.id !== 'string') return [];
      return [{ id: row.id, group, facts: Object.fromEntries(fields.flatMap(key => {
        const v = row[key];
        return typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v) ? [[key, String(v)]] : [];
      })) }];
    });
  });
}
