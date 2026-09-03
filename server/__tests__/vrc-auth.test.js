function jsonResponse(status, data, setCookie = []) {
  return {
    status,
    headers: {
      getSetCookie: () => setCookie,
      get: () => null
    },
    arrayBuffer: async () => Buffer.from(JSON.stringify(data))
  };
}

describe('VRChat authentication compatible with VRCX', () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('loads config, URI-encodes credentials and stores only cookie pairs', async () => {
    global.fetch
      .mockResolvedValueOnce(jsonResponse(200, { apiVersion: 1 }))
      .mockResolvedValueOnce(jsonResponse(
        200,
        { id: 'usr_1', displayName: 'Tester' },
        [
          'auth=authcookie_token; Path=/; HttpOnly; SameSite=Lax',
          'foo=bar; Path=/'
        ]
      ));
    const { vrchatBasicLogin } = require('../vrc');

    const result = await vrchatBasicLogin('user@example.com', 'p:a ss');

    expect(global.fetch.mock.calls[0][0]).toBe('https://api.vrchat.cloud/api/1/config');
    expect(global.fetch.mock.calls[1][0]).toBe('https://api.vrchat.cloud/api/1/auth/user');
    const expected = Buffer.from('user%40example.com:p%3Aa%20ss').toString('base64');
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe(`Basic ${expected}`);
    expect(result.cookie).toBe('auth=authcookie_token; foo=bar');
  });

  test('merges the two-factor cookie into the existing authentication jar', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse(
      200,
      { verified: true },
      ['twoFactorAuth=twofactor_token; Path=/; HttpOnly']
    ));
    const { vrchatVerifyTwoFactor } = require('../vrc');

    const result = await vrchatVerifyTwoFactor('totp', '123456', 'auth=authcookie_token');

    expect(global.fetch.mock.calls[0][0]).toBe(
      'https://api.vrchat.cloud/api/1/auth/twofactorauth/totp/verify'
    );
    expect(global.fetch.mock.calls[0][1].headers.Cookie).toBe('auth=authcookie_token');
    expect(result.cookie).toBe('auth=authcookie_token; twoFactorAuth=twofactor_token');
  });

  test('uses the selected email OTP endpoint instead of guessing methods', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse(200, { verified: true }));
    const { vrchatVerifyTwoFactor } = require('../vrc');

    await vrchatVerifyTwoFactor('emailOtp', '123456', 'auth=authcookie_token');

    expect(global.fetch.mock.calls[0][0]).toBe(
      'https://api.vrchat.cloud/api/1/auth/twofactorauth/emailotp/verify'
    );
  });

  test('checks the cookie-backed current user without an obsolete API key query', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse(200, { id: 'usr_1' }));
    const { vrchatGetCurrentUserResult } = require('../vrc');

    const result = await vrchatGetCurrentUserResult('auth=authcookie_token');

    expect(global.fetch.mock.calls[0][0]).toBe('https://api.vrchat.cloud/api/1/auth/user');
    expect(result.data.id).toBe('usr_1');
  });

  test('specifies the all marketplace for avatar text search', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse(200, []));
    const { vrchatSearchAvatars } = require('../vrc');

    await vrchatSearchAvatars('avatar name', 10, 'auth=authcookie_token');

    expect(global.fetch.mock.calls[0][0]).toContain(
      '/avatars?search=avatar%20name&n=10&marketplace=all'
    );
  });
});
