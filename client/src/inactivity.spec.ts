const IDLE_LIMIT_MS = 2 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 10 * 1000;
const ACTIVITY_KEY = 'librechat.lastActivity';

type SetupOptions = {
  authenticated?: boolean;
  storedActivity?: number;
};

type Harness = {
  logout: jest.Mock;
  refreshToken: jest.Mock;
  setTokenHeader: jest.Mock;
};

/** jsdom locks down `location.assign`, so the redirect surfaces as an unimplemented-navigation error. */
const isNavigationNotice = (arg: unknown): boolean => {
  if (typeof arg === 'string') {
    return arg.includes('Not implemented: navigation');
  }
  return arg instanceof Error && arg.message.includes('Not implemented: navigation');
};

describe('inactivity logout', () => {
  let stopModule: (() => void) | null = null;
  let authorize: () => void = () => undefined;

  const setup = async ({
    authenticated = true,
    storedActivity,
  }: SetupOptions = {}): Promise<Harness> => {
    const common: Record<string, string> = authenticated
      ? { Authorization: 'Bearer test-token' }
      : {};
    const logout = jest.fn().mockResolvedValue({ message: 'Logout successful' });
    const refreshToken = jest.fn().mockResolvedValue({ token: 'renewed-token' });
    const dispatchTokenUpdatedEvent = jest.fn();
    const setTokenHeader = jest.fn();
    authorize = () => {
      common.Authorization = 'Bearer test-token';
    };

    jest.doMock('axios', () => ({
      __esModule: true,
      default: { defaults: { headers: { common } } },
    }));
    jest.doMock('librechat-data-provider', () => ({
      apiBaseUrl: () => '',
      buildLoginRedirectUrl: () => '/login',
      setTokenHeader,
      dataService: { logout },
      request: { refreshToken, dispatchTokenUpdatedEvent },
    }));

    if (storedActivity != null) {
      window.localStorage.setItem(ACTIVITY_KEY, String(storedActivity));
    }

    const { stopInactivityLogout } = await import('./inactivity');
    stopModule = stopInactivityLogout;
    return { logout, refreshToken, setTokenHeader };
  };

  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const originalConsoleError = console.error;

  beforeAll(() => {
    /** Assigned rather than spied so `restoreMocks` cannot uninstall it between tests. */
    console.error = (...args: unknown[]) => {
      if (args.some(isNavigationNotice)) {
        return;
      }
      originalConsoleError(...args);
    };
  });

  afterAll(() => {
    console.error = originalConsoleError;
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();
    window.localStorage.clear();
  });

  afterEach(() => {
    stopModule?.();
    stopModule = null;
    jest.useRealTimers();
  });

  it('logs out after the idle limit elapses without interaction', async () => {
    const { logout, setTokenHeader } = await setup();

    jest.advanceTimersByTime(IDLE_LIMIT_MS + CHECK_INTERVAL_MS);
    await flush();

    expect(logout).toHaveBeenCalledTimes(1);
    expect(setTokenHeader).toHaveBeenCalledWith(undefined);
  });

  it('restarts the idle window on interaction', async () => {
    const { logout } = await setup();

    jest.advanceTimersByTime(IDLE_LIMIT_MS - 60_000);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    jest.advanceTimersByTime(IDLE_LIMIT_MS - 60_000);
    await flush();

    expect(logout).not.toHaveBeenCalled();

    jest.advanceTimersByTime(2 * 60_000);
    await flush();

    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('expires a session that sat idle while the tab was closed', async () => {
    const { logout } = await setup({ storedActivity: Date.now() - (IDLE_LIMIT_MS + 60_000) });

    jest.advanceTimersByTime(CHECK_INTERVAL_MS);
    await flush();

    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('bounces an expired load as soon as the app restores the token', async () => {
    const { logout } = await setup({
      authenticated: false,
      storedActivity: Date.now() - (IDLE_LIMIT_MS + 60_000),
    });

    jest.advanceTimersByTime(1_000);
    await flush();
    expect(logout).not.toHaveBeenCalled();

    authorize();
    jest.advanceTimersByTime(600);
    await flush();

    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('gives up probing once the token never arrives', async () => {
    const { logout } = await setup({
      authenticated: false,
      storedActivity: Date.now() - (IDLE_LIMIT_MS + 60_000),
    });

    jest.advanceTimersByTime(25_000);
    authorize();
    jest.advanceTimersByTime(600);
    await flush();

    expect(logout).not.toHaveBeenCalled();

    jest.advanceTimersByTime(CHECK_INTERVAL_MS);
    await flush();

    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('renews an expired access token and revokes again', async () => {
    const { logout, refreshToken } = await setup();
    logout.mockRejectedValueOnce(new Error('Request failed with status code 401'));

    jest.advanceTimersByTime(20_000);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    jest.advanceTimersByTime(IDLE_LIMIT_MS + CHECK_INTERVAL_MS);
    await flush();
    await flush();

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem(ACTIVITY_KEY)).toBeNull();
  });

  it('keeps the timestamp when the session cannot be revoked', async () => {
    const { logout, refreshToken } = await setup();
    logout.mockRejectedValue(new Error('Request failed with status code 401'));
    refreshToken.mockResolvedValue({ message: 'Refresh token not provided' });

    jest.advanceTimersByTime(20_000);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    jest.advanceTimersByTime(IDLE_LIMIT_MS + CHECK_INTERVAL_MS);
    await flush();
    await flush();

    expect(logout).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(ACTIVITY_KEY)).not.toBeNull();
  });

  it('ignores the interaction that wakes an expired tab', async () => {
    const { logout } = await setup({ storedActivity: Date.now() - (IDLE_LIMIT_MS + 60_000) });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    jest.advanceTimersByTime(CHECK_INTERVAL_MS);
    await flush();

    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('still records activity while another tab keeps the shared clock fresh', async () => {
    const { logout } = await setup();

    for (let index = 0; index < 6; index += 1) {
      jest.advanceTimersByTime(30 * 60_000);
      window.localStorage.setItem(ACTIVITY_KEY, String(Date.now()));
    }
    await flush();
    expect(logout).not.toHaveBeenCalled();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(Number(window.localStorage.getItem(ACTIVITY_KEY))).toBe(Date.now());

    jest.advanceTimersByTime(IDLE_LIMIT_MS - 60_000);
    await flush();
    expect(logout).not.toHaveBeenCalled();
  });

  it('stays put when no session is present', async () => {
    const { logout, setTokenHeader } = await setup({ authenticated: false });

    jest.advanceTimersByTime(IDLE_LIMIT_MS * 2);
    await flush();

    expect(logout).not.toHaveBeenCalled();
    expect(setTokenHeader).not.toHaveBeenCalled();
  });

  it('clears the stored timestamp once the server confirms the logout', async () => {
    await setup();

    jest.advanceTimersByTime(20_000);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(window.localStorage.getItem(ACTIVITY_KEY)).not.toBeNull();

    jest.advanceTimersByTime(IDLE_LIMIT_MS + CHECK_INTERVAL_MS);
    await flush();

    expect(window.localStorage.getItem(ACTIVITY_KEY)).toBeNull();
  });
});
