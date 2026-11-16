import { describe, expect, it } from 'vitest';
import { initials, truncateLabel, wrapText } from './graphText';

describe('graph labels', () => {
  it('gives distinct initials to agents whose names end with "Agent"', () => {
    expect(initials('Data Agent')).toBe('DA');
    expect(initials('Documentation Agent')).toBe('DO');
    expect(initials('Security reviewer')).toBe('SR');
    expect(initials('software-engineering')).toBe('SE');
    expect(initials('Agent')).toBe('AG');
  });

  it('wraps titles on word boundaries with an ellipsis when cut', () => {
    expect(wrapText('Write the tests and the validation', 20, 2)).toEqual(['Write the tests and', 'the validation']);
    expect(wrapText('one two three four five six seven', 9, 2)).toEqual(['one two', 'three…']);
    expect(wrapText('supercalifragilistic', 8, 1)).toEqual(['superca…']);
    expect(truncateLabel('shell_run_with_a_long_name', 12)).toBe('shell_run_w…');
  });
});
