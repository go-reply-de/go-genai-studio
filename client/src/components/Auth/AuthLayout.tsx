import { ThemeSelector } from '~/components/ui';
import { useLocalize } from '~/hooks';
import { TStartupConfig } from 'librechat-data-provider';
import SocialLoginRender from './SocialLoginRender';
import Footer from './Footer';

const ErrorRender = ({ children }: { children: React.ReactNode }) => (
  <div className="mt-16 flex justify-center">
    <div
      role="alert"
      aria-live="assertive"
      className="rounded-md border border-red-500 bg-red-500/10 px-3 py-2 text-sm text-gray-600 dark:text-gray-200"
    >
      {children}
    </div>
  </div>
);

const circleStyle = {
  position: 'absolute',
  bottom: '0',
  right: '0',
  width: '150px',
  height: '150px' /* Half the width for a semicircle */,
  borderradius: '100px 100px 0 0' /* Top corners are rounded, bottom corners are flat */,
  backgroundColor: 'blue',
};

function AuthLayout({
  children,
  header,
  isFetching,
  startupConfig,
  startupConfigError,
  pathname,
  error,
}: {
  children: React.ReactNode;
  header: React.ReactNode;
  isFetching: boolean;
  startupConfig: TStartupConfig | null | undefined;
  startupConfigError: unknown | null | undefined;
  pathname: string;
  error: string | null;
}) {
  const localize = useLocalize();

  const Description = () => (
    <p className="mt-6 whitespace-pre-line text-xl/8 font-medium text-gray-950/75 dark:text-gray-200">
      {localize('com_description')}
    </p>
  );

  const DisplayError = () => {
    if (startupConfigError !== null && startupConfigError !== undefined) {
      return <ErrorRender>{localize('com_auth_error_login_server')}</ErrorRender>;
    } else if (error === 'com_auth_error_invalid_reset_token') {
      return (
        <ErrorRender>
          {localize('com_auth_error_invalid_reset_token')}{' '}
          <a className="font-semibold text-blue-600 hover:underline" href="/forgot-password">
            {localize('com_auth_click_here')}
          </a>{' '}
          {localize('com_auth_to_try_again')}
        </ErrorRender>
      );
    } else if (error != null && error) {
      return <ErrorRender>{localize(error)}</ErrorRender>;
    }
    return null;
  };

  return (
    <div className="parent relative flex min-h-screen w-screen flex-col px-2 pt-2">
      <div className="w-full flex-wrap px-2 pb-20 pt-2 md:px-20  md:pb-20 md:pt-16 lg:px-32 lg:pb-20 lg:pt-16">
        <nav className="flex justify-between py-3">
          <div className="flex flex-wrap items-center gap-6">
            <a href="/">
              <img
                src="/assets/main_logo.png"
                className="h-20 w-full object-contain"
                alt="Logo"
              />
            </a>
            <div className="rounded-full bg-blue-400 px-3 py-0.5 font-medium text-white dark:bg-blue-500">
              {localize('com_header_description')}
            </div>
          </div>
        </nav>

        <div className="absolute bottom-0 left-0 md:m-4">
          <ThemeSelector />
        </div>

        <div className="child w-full flex-1 items-center justify-center">
          <div className="mb-20 mt-32">
            {!startupConfigError && !isFetching && (
              <h1
                className="word-break: break-word text-5xl font-medium text-gray-950 dark:text-white md:text-5xl lg:text-9xl"
                style={{ userSelect: 'none' }}
              >
                {header}.
              </h1>
            )}
            <Description />
            {children}
            <div className="mt-12">
              {(pathname.includes('login') || pathname.includes('register')) && (
                <SocialLoginRender startupConfig={startupConfig} />
              )}
            </div>
          </div>
        </div>

        <div className="relative flex flex-col bg-white dark:bg-gray-900">
          <DisplayError />
        </div>
        <div>
          <Footer startupConfig={startupConfig} />
        </div>
      </div>
    </div>
  );
}

export default AuthLayout;