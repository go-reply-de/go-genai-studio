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

const renderAnswer = (content: string) => {
  const searchResults = {
    '0': { turn: 0, organic: [awmf, dgai] },
  } as unknown as Record<string, SearchResultData>;
  render(
    <MemoryRouter>
      <RecoilRoot>
        <MessageContext.Provider value={{ messageId: 'm1', isExpanded: true }}>
          <SearchContext.Provider value={{ searchResults }}>
            <Markdown content={content} isLatestMessage={false} />
          </SearchContext.Provider>
        </MessageContext.Provider>
      </RecoilRoot>
    </MemoryRouter>,
  );
};

describe('anchors written as [turn0search0, …]', () => {
  it('reads them as the anchors they stand for', () => {
    expect(asAnchors('Bis 2 h. [turn0search0, turn0search1] Bis 6 h. [turn0search2]')).toBe(
      'Bis 2 h. \\ue200\\ue202turn0search0\\ue202turn0search1\\ue201 Bis 6 h. \\ue202turn0search2',
    );
    expect(asAnchors('Eine Liste [1, 2] bleibt.')).toBe('Eine Liste [1, 2] bleibt.');
  });

  it('shows them as chips', async () => {
    renderAnswer(
      'Klare Flüssigkeiten bis 2 h. [turn0search0, turn0search1] Feste Kost bis 6 h. [turn0search1]',
    );

    expect(await screen.findByRole('link', { name: 'awmf.org +1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'dgai.de' })).toBeInTheDocument();
    expect(screen.queryByText(/turn0search/)).not.toBeInTheDocument();
  });
});

describe('groups written as \\ue200entity|…\\ue201', () => {
  it('reads them as the anchors they stand for', () => {
    expect(
      asAnchors(
        'Ab 60 Jahren. \ue200entity|turn0search0\tturn0search1\ue201 Einmalig. \ue200entity|turn0search1\ue201',
      ),
    ).toBe(
      'Ab 60 Jahren. \\ue200\\ue202turn0search0\\ue202turn0search1\\ue201 Einmalig. \\ue202turn0search1',
    );
    expect(asAnchors('Auch \\ue200entity|turn0search0\\ue201 als Text.')).toBe(
      'Auch \\ue202turn0search0 als Text.',
    );
    expect(asAnchors('Ein Wert entity|turn0search0 ohne Klammer bleibt.')).toBe(
      'Ein Wert entity|turn0search0 ohne Klammer bleibt.',
    );
  });

  it('shows them as chips', async () => {
    renderAnswer(
      'Pneumokokken ab 60. \ue200entity|turn0search0\tturn0search1\ue201 Mit PCV20. \ue200entity|turn0search1\ue201',
    );

    expect(await screen.findByRole('link', { name: 'awmf.org +1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'dgai.de' })).toBeInTheDocument();
    expect(screen.queryByText(/entity\||turn0search/)).not.toBeInTheDocument();
  });
});
