import { render, screen } from '@testing-library/react';
import type { TStartupConfig } from 'librechat-data-provider';
import BrandedAuthLayout from '~/components/Auth/BrandedAuthLayout';

const startupConfig = {
  interface: {
    privacyPolicy: { externalUrl: 'https://example.test/privacy' },
    termsOfService: { externalUrl: 'https://example.test/terms' },
  },
} as unknown as TStartupConfig;

function renderLayout(props: Partial<Parameters<typeof BrandedAuthLayout>[0]> = {}) {
  return render(
    <BrandedAuthLayout
      header="Welcome back"
      isFetching={false}
      startupConfig={startupConfig}
      startupConfigError={null}
      pathname="/forgot-password"
      error={null}
      {...props}
    >
      <div data-testid="form" />
    </BrandedAuthLayout>,
  );
}

describe('BrandedAuthLayout', () => {
  it('shows the header, brand texts and the form', () => {
    renderLayout();

    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByText('Your very own AI Chatbot')).toBeInTheDocument();
    expect(screen.getByTestId('form')).toBeInTheDocument();
  });

  it('shows the server error and hides the header when the startup config fails', () => {
    renderLayout({ startupConfig: null, startupConfigError: new Error('down') });

    expect(
      screen.getByText(
        'There was an internal server error. Please wait a few moments and try again.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('shows the error the login flow passes in', () => {
    renderLayout({ error: 'com_auth_error_login' });

    expect(
      screen.getByText(
        'Unable to login with the information provided. Please check your credentials and try again.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the privacy and terms links from the startup config', () => {
    renderLayout();

    expect(screen.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute(
      'href',
      'https://example.test/privacy',
    );
    expect(screen.getByRole('link', { name: 'Terms of service' })).toHaveAttribute(
      'href',
      'https://example.test/terms',
    );
  });
});
