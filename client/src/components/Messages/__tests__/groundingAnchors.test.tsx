import React from 'react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SearchResultData } from 'librechat-data-provider';
import { asAnchors } from '~/components/Messages/groundingAnchors';
import Markdown from '~/components/Chat/Messages/Content/Markdown';
import { MessageContext, SearchContext } from '~/Providers';

const awmf = { position: 1, link: 'https://stub/awmf', title: 'awmf.org', attribution: 'awmf.org' };
const dgai = { position: 2, link: 'https://stub/dgai', title: 'dgai.de', attribution: 'dgai.de' };

describe('anchors written as [turn0search0, …]', () => {
  it('reads them as the anchors they stand for', () => {
    expect(asAnchors('Bis 2 h. [turn0search0, turn0search1] Bis 6 h. [turn0search2]')).toBe(
      'Bis 2 h. \\ue200\\ue202turn0search0\\ue202turn0search1\\ue201 Bis 6 h. \\ue202turn0search2',
    );
    expect(asAnchors('Eine Liste [1, 2] bleibt.')).toBe('Eine Liste [1, 2] bleibt.');
  });

  it('shows them as chips', async () => {
    const searchResults = {
      '0': { turn: 0, organic: [awmf, dgai] },
    } as unknown as Record<string, SearchResultData>;
    render(
      <MemoryRouter>
        <RecoilRoot>
          <MessageContext.Provider value={{ messageId: 'm1', isExpanded: true }}>
            <SearchContext.Provider value={{ searchResults }}>
              <Markdown
                content={
                  'Klare Flüssigkeiten bis 2 h. [turn0search0, turn0search1] Feste Kost bis 6 h. [turn0search1]'
                }
                isLatestMessage={false}
              />
            </SearchContext.Provider>
          </MessageContext.Provider>
        </RecoilRoot>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('link', { name: 'awmf.org +1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'dgai.de' })).toBeInTheDocument();
    expect(screen.queryByText(/turn0search/)).not.toBeInTheDocument();
  });
});
