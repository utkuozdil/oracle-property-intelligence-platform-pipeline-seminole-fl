import { describe, expect, it } from 'vitest';
import { overlay } from './agent-tools';

describe('overlay', () => {
  it('inherits when the model omits a field', () => {
    expect(overlay(undefined, 'Longwood')).toBe('Longwood');
    expect(overlay(undefined, 5)).toBe(5);
  });

  it('clears when the model sends null', () => {
    expect(overlay(null, 20)).toBeUndefined();
  });

  it('uses the new value when the model sends one', () => {
    expect(overlay(3, 5)).toBe(3);
    expect(overlay('Sanford', 'Longwood')).toBe('Sanford');
  });
});
