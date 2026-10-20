import { describe, expect, it } from 'vitest';
import {
  extractPostalCode,
  geocodeChain,
  PostalGazetteerStep,
  unresolvedReason,
  type GeocodeResult,
  type GeocodeStep,
} from '../../src/geo/geocoder.js';

// The vendor feed has addresses and no coordinates. These tests pin down how a
// location is chosen and, when it can't be, what the operator is told.

const gazetteer = new PostalGazetteerStep([
  { country: 'IN', postal_code: '201301', place: 'Noida', lat: 28.575, lng: 77.33 },
  { country: 'DE', postal_code: '70173', place: 'Stuttgart-Mitte', lat: 48.778, lng: 9.18 },
]);

const fixed = (name: string, r: Partial<GeocodeResult> | null): GeocodeStep => ({
  name,
  geocode: async () => (r ? ({ lat: 1, lng: 2, precision: 'street', source: name, confidence: 1, note: name, ...r } as GeocodeResult) : null),
});

describe('choosing a location from an address', () => {
  it('takes the first step that answers: a manual pin beats everything after it', async () => {
    const r = await geocodeChain(
      [fixed('manual_override', { precision: 'rooftop' }), fixed('geocode_cache', {}), gazetteer],
      { siteId: 'S-1', address: 'Sector 18, Noida, UP 201301', country: 'IN' },
    );
    expect(r?.source).toBe('manual_override');
  });

  it('falls back to the postal-area centre, and says the pin is only approximate', async () => {
    const r = await geocodeChain([fixed('manual_override', null), fixed('geocode_cache', null), gazetteer], {
      siteId: 'S-1',
      address: 'Plot 12, Sector 18, Noida, UP 201301',
      country: 'IN',
    });
    expect(r).toMatchObject({ precision: 'postal_code', source: 'postal_gazetteer', lat: 28.575, lng: 77.33 });
    expect(r?.note).toContain('postal area 201301');
    expect(r?.note).toContain('±2 km');
  });

  it('reads the postal code, not a house number, from German and Indian addresses', () => {
    expect(extractPostalCode('Ladestation Hauptbahnhof, Arnulf-Klett-Platz 2, 70173 Stuttgart', 'DE')).toBe('70173');
    expect(extractPostalCode('Phoenix Marketcity, Whitefield Rd, Mahadevapura, Bengaluru, KA 560048', 'IN')).toBe('560048');
  });
});

describe('when no location can be found', () => {
  it('returns nothing rather than guessing', async () => {
    const r = await geocodeChain([fixed('manual_override', null), gazetteer], {
      siteId: 'S-1',
      address: 'Plot 24, Anna Salai, Chennai, TN 600002',
      country: 'IN',
    });
    expect(r).toBeNull();
  });

  it('tells the operator why: no postal code, or a postal code we do not cover', () => {
    expect(unresolvedReason('Near old bus depot, NH-48 service road', 'IN')).toBe('No postal code in the address');
    expect(unresolvedReason('Plot 24, Anna Salai, Chennai, TN 600002', 'IN')).toBe('Postal code 600002 is not in the postal-code list');
  });
});
