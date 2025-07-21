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
    : modalContent || "The Terms of Service content could not be loaded.";

  return (
    <div className="bg-gray-50 text-gray-800 min-h-screen py-12 font-['Inter',_sans-serif] items-center">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <header className="text-center mb-10">
          <h1 className="text-4xl font-bold text-gray-900">{localize("com_ui_terms_of_service")}</h1>
          <p className="text-lg text-gray-600 mt-2">{localize('com_ui_tos_instructions')}</p>
        </header>

        <main className="bg-white p-8 rounded-lg shadow-md">
          <div className="prose prose-lg mx-auto">
            <ReactMarkdown rehypePlugins={[rehypeRaw]}>
              {content}
            </ReactMarkdown>
          </div>
        </main>

        <footer className="text-center mt-10 text-gray-500 text-sm">
          <p>&copy; {new Date().getFullYear()} Go Reply. All Rights Reserved.</p>
        </footer>
      </div>
    </div>
  );
}


export default TermsOfService;