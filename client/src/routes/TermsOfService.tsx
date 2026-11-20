import React, { useEffect } from 'react';
import rehypeRaw from 'rehype-raw';
import ReactMarkdown from 'react-markdown';
import { TranslationKeys, useLocalize } from '~/hooks';
import { useGetStartupConfig } from '~/data-provider';
import '~/locales/brandStrings';

function TermsOfService() {
  const { data: config } = useGetStartupConfig();

  const localize = useLocalize();

  // This route sits outside the main app layout, so it never goes through
  // useAppStartup's document.title effect - set it here too, or the tab
  // falls back to index.html's static default ("Go GenAI Studio").
  useEffect(() => {
    if (config?.appTitle) {
      document.title = config.appTitle;
    }
  }, [config?.appTitle]);

  const termsOfService = config?.interface?.termsOfService;

  const modalContent = termsOfService?.modalContent;
  const content = Array.isArray(modalContent)
    ? modalContent.join('\n\n')
    : modalContent || 'The Terms of Service content could not be loaded.';

  // Theme colours throughout: `prose` reads the theme, so a fixed white card turns its text unreadable in dark mode.
  return (
    <div className="bg-surface-secondary text-text-primary min-h-screen py-12">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
        <header className="mb-10 text-center">
          <h1 className="text-text-primary text-4xl font-bold">
            {localize('com_ui_terms_of_service')}
          </h1>
          <p className="text-text-secondary mt-2 text-lg">
            {localize('com_ui_tos_instructions' as TranslationKeys)}
          </p>
        </header>

        <main className="bg-surface-primary rounded-lg p-8 shadow-md">
          <div className="prose mx-auto">
            <ReactMarkdown rehypePlugins={[rehypeRaw]}>{content}</ReactMarkdown>
          </div>
        </main>

        <footer className="text-text-tertiary mt-10 text-center text-sm">
          <p>
            {localize('com_ui_tos_copyright' as TranslationKeys, {
              0: String(new Date().getFullYear()),
            })}
          </p>
        </footer>
      </div>
    </div>
  );
}

export default TermsOfService;
