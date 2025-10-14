import { useGetStartupConfig } from '~/data-provider';
import React from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { useLocalize } from '~/hooks';

function TermsOfService({ className }: { className?: string }) {
  const { data: config } = useGetStartupConfig();

  const localize = useLocalize();

  const termsOfService = config?.interface?.termsOfService;

  const modalContent = termsOfService?.modalContent;
  const content = Array.isArray(modalContent)
    ? modalContent.join('\n\n')
    : modalContent || 'The Terms of Service content could not be loaded.';

  return (
    <div className="min-h-screen items-center bg-gray-50 py-12 font-['Inter',_sans-serif] text-gray-800">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
        <header className="mb-10 text-center">
          <h1 className="text-4xl font-bold text-gray-900">
            {localize('com_ui_terms_of_service')}
          </h1>
          <p className="mt-2 text-lg text-gray-600">{localize('com_ui_tos_instructions')}</p>
        </header>

        <main className="rounded-lg bg-white p-8 shadow-md">
          <div className="prose prose-lg mx-auto">
            <ReactMarkdown rehypePlugins={[rehypeRaw]}>{content}</ReactMarkdown>
          </div>
        </main>

        <footer className="mt-10 text-center text-sm text-gray-500">
          <p>&copy; {new Date().getFullYear()} Go Reply. All Rights Reserved.</p>
        </footer>
      </div>
    </div>
  );
}

export default TermsOfService;