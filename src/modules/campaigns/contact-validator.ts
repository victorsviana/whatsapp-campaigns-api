const BRAZIL_COUNTRY_CODE = '55';
const VALID_PHONE_PATTERN = /^55[1-9]{2}(?:9\d{8}|\d{8})$/;

export type PhoneResult =
  | { ok: true; phone: string }
  | { ok: false; reason: 'missing_phone' | 'invalid_phone' };

export function normalizePhone(raw: unknown): PhoneResult {
  if (raw === undefined || raw === null) {
    return { ok: false, reason: 'missing_phone' };
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { ok: false, reason: 'invalid_phone' };
  }

  const text = String(raw);
  if (text.trim() === '') {
    return { ok: false, reason: 'missing_phone' };
  }

  let digits = text.replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length === 10 || digits.length === 11) {
    digits = BRAZIL_COUNTRY_CODE + digits;
  }

  if (!VALID_PHONE_PATTERN.test(digits)) {
    return { ok: false, reason: 'invalid_phone' };
  }
  return { ok: true, phone: `+${digits}` };
}
