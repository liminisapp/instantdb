import { describe, expect, test } from 'vitest';
import { sdkInstallSpec } from '../src/util/sdkInstallSpec.ts';

describe('sdkInstallSpec', () => {
  test("upstream's CLI installs packages by name", () => {
    const self = { name: 'instant-cli', version: '1.0.67' };
    expect(sdkInstallSpec('@instantdb/react', self)).toBe('@instantdb/react');
  });

  test("the fork's CLI installs its own build under the @instantdb name", () => {
    const self = { name: '@liminis/instant-cli', version: '1.0.67-lm.2' };
    expect(sdkInstallSpec('@instantdb/react', self)).toBe(
      '@instantdb/react@npm:@liminis/instant-react@1.0.67-lm.2',
    );
    expect(sdkInstallSpec('@instantdb/react-native', self)).toBe(
      '@instantdb/react-native@npm:@liminis/instant-react-native@1.0.67-lm.2',
    );
  });

  test('packages that are not Instant SDKs are installed by name', () => {
    const self = { name: '@liminis/instant-cli', version: '1.0.67-lm.2' };
    expect(sdkInstallSpec('react-native-get-random-values', self)).toBe(
      'react-native-get-random-values',
    );
  });

  test('a CLI that cannot read its own package.json installs by name', () => {
    expect(sdkInstallSpec('@instantdb/react', {})).toBe('@instantdb/react');
  });
});
