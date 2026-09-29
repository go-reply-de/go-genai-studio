import React from 'react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SearchResultData } from 'librechat-data-provider';
import {
  GroundingHints,
  hasHintsMarker,
  stripGroundingMarkup,
} from '~/components/Messages/GroundingHints';
import Markdown from '~/components/Chat/Messages/Content/Markdown';
import { MessageContext, SearchContext } from '~/Providers';

const HEADING = 'Ergänzende Hinweise – bitte eigenständig prüfen';

type HintSource = { domain: string; link: string };
const hint = (text: string, topic: string | null = null, sources: HintSource[] = []) => ({
  topic,
  text,
  sources,
});
const awmf = { position: 1, link: 'https://stub/awmf', title: 'awmf.org', attribution: 'awmf.org' };
const results = (organic: object[], hints: object[]) =>
  ({ '0': { turn: 0, organic, hints } }) as unknown as Record<string, SearchResultData>;

const toggle = () => screen.getByRole('button', { name: new RegExp(HEADING) });
const openPanel = () => fireEvent.click(toggle());

describe('GroundingHints', () => {
  it('stays collapsed under an answer that listed sources back', () => {
    const searchResults = results([awmf], [hint('Kein Nystagmus.'), hint('Kopfimpuls normal.')]);

    render(<GroundingHints searchResults={searchResults} />);

    expect(toggle()).toHaveTextContent(`⚠ ${HEADING} (2)`);
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Kein Nystagmus.')).not.toBeInTheDocument();

    fireEvent.click(toggle());

    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Kein Nystagmus.')).toBeInTheDocument();
  });

  it('says what the hints are not backed by, even while collapsed', () => {
    render(<GroundingHints searchResults={results([awmf], [hint('Kein Nystagmus.')])} />);

    expect(toggle()).toHaveAccessibleDescription(
      /nicht durch AWMF, Fachgesellschaften, Behörden \(z\. B\. RKI, BfArM, EMA\) oder die Fachinformation belegt/,
    );
    expect(screen.getByRole('region', { name: HEADING })).not.toHaveTextContent(/offiziell/i);
  });

  it('shows no panel when no listed source backs the answer, which then is that text', () => {
    const blog = { ...awmf, link: 'https://stub/blog', title: 'blog.example', official: false };

    const { container } = render(
      <GroundingHints searchResults={results([blog], [hint('Kein Nystagmus.')])} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('groups the hints under their topic and links each source domain once', () => {
    const blog = [
      { domain: 'blog.example', link: 'https://stub/blog-1' },
      { domain: 'blog.example', link: 'https://stub/blog-2' },
      { domain: 'praxis.example', link: 'https://stub/praxis' },
    ];
    const searchResults = results(
      [awmf],
      [
        hint('Richtungswechselnd spricht für zentral.', 'Nystagmus', blog),
        hint('Vertikal spricht für zentral.', 'Nystagmus'),
      ],
    );

    render(<GroundingHints searchResults={searchResults} />);
    openPanel();

    const group = screen.getByText('Nystagmus').parentElement as HTMLElement;
    expect(group).toHaveTextContent('Richtungswechselnd spricht für zentral.');
    expect(group).toHaveTextContent('Vertikal spricht für zentral.');
    const links = screen.getAllByRole('link');
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['blog.example', 'https://stub/blog-1'],
      ['praxis.example', 'https://stub/praxis'],
    ]);
    expect(links[0]).toHaveAttribute('target', '_blank');
    expect(screen.getByText('Vertikal spricht für zentral.')).toHaveTextContent('ohne Quelle');
  });

  it('lists what a lead-in introduces under it and counts every point', () => {
    const lead = {
      ...hint('Zentral verdächtig, wenn eines der Kriterien erfüllt ist:', 'Konsequenz'),
      items: [
        { text: 'Der Kopfimpulstest ist normal.', sources: [] },
        { text: 'Es besteht eine akute Hörminderung.', sources: [] },
      ],
    };

    render(<GroundingHints searchResults={results([awmf], [lead])} />);
    openPanel();

    expect(toggle()).toHaveTextContent('(3)');
    const nested = screen.getByText('Der Kopfimpulstest ist normal.').closest('ul') as HTMLElement;
    expect(nested.closest('li')).toHaveTextContent(
      'Zentral verdächtig, wenn eines der Kriterien erfüllt ist:',
    );
    expect(nested).toHaveTextContent('Es besteht eine akute Hörminderung.');
  });

  it('keeps the order of the answer when a topic comes back later', () => {
    const searchResults = results(
      [awmf],
      [
        hint('Erster Punkt.', 'Befund'),
        hint('Zweiter Punkt.', 'Therapie'),
        hint('Dritter Punkt.', 'Befund'),
      ],
    );

    render(<GroundingHints searchResults={searchResults} />);
    openPanel();

    const texts = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(texts.map((text) => text?.replace('ohne Quelle', ''))).toEqual([
      'Erster Punkt.',
      'Zweiter Punkt.',
      'Dritter Punkt.',
    ]);
    expect(screen.getAllByText('Befund')).toHaveLength(2);
  });

  it('shows a hint that several searches returned only once', () => {
    const searchResults = {
      ...results([awmf], [hint('Kein Nystagmus.')]),
      '1': { turn: 1, organic: [], hints: [hint('Kein Nystagmus.')] },
    } as unknown as Record<string, SearchResultData>;

    render(<GroundingHints searchResults={searchResults} />);

    expect(toggle()).toHaveTextContent('(1)');
  });

  it('reads the hints of the answer it is rendered in', () => {
    render(
      <SearchContext.Provider value={{ searchResults: results([awmf], [hint('Kein Nystagmus.')]) }}>
        <GroundingHints />
      </SearchContext.Provider>,
    );
    openPanel();

    expect(screen.getByText('Kein Nystagmus.')).toBeInTheDocument();
  });

  it('renders nothing when the search left no hints', () => {
    const { container } = render(<GroundingHints searchResults={results([awmf], [])} />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe('hints marker', () => {
  it('counts only a line of its own as the marker', () => {
    expect(hasHintsMarker('Antwort.\n\n::hinweise\n\nPflicht-Hinweis.')).toBe(true);
    expect(hasHintsMarker('Die Zeile ::hinweise zählt nicht.')).toBe(false);
  });

  it('leaves the marker out of a copied answer', () => {
    expect(stripGroundingMarkup('Antwort.\n\n::hinweise\n\nPflicht-Hinweis.')).toBe(
      'Antwort.\n\nPflicht-Hinweis.',
    );
    expect(stripGroundingMarkup('WARNUNG: nicht belegt.\n\n::hinweise')).toBe(
      'WARNUNG: nicht belegt.',
    );
    expect(stripGroundingMarkup('Die Zeile ::hinweise bleibt.')).toBe(
      'Die Zeile ::hinweise bleibt.',
    );
  });

  it('keeps the note of an answer without listed sources as plain text when copied', () => {
    expect(
      stripGroundingMarkup(
        '::quellenvermerk[Nicht durch AWMF belegt.]\n\nText.\n\n---\n\n*Achtung*',
      ),
    ).toBe('Nicht durch AWMF belegt.\n\nText.\n\n---\n\n*Achtung*');
  });

  it('shows the note of an answer without listed sources as a highlighted box before the text', async () => {
    render(
      <MemoryRouter>
        <RecoilRoot>
          <MessageContext.Provider value={{ messageId: 'm1', isExpanded: true }}>
            <Markdown
              content={'::quellenvermerk[Nicht durch AWMF belegt.]\n\nDer Wells-Score hilft.'}
              isLatestMessage={false}
            />
          </MessageContext.Provider>
        </RecoilRoot>
      </MemoryRouter>,
    );

    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('⚠ Nicht durch AWMF belegt.');
    expect(note).toHaveClass('bg-amber-50/70');
    expect(
      note.compareDocumentPosition(screen.getByText('Der Wells-Score hilft.')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText(/::quellenvermerk/)).not.toBeInTheDocument();
  });

  it('puts the panel where the agent placed the marker, before the disclaimer', async () => {
    render(
      <MemoryRouter>
        <RecoilRoot>
          <MessageContext.Provider value={{ messageId: 'm1', isExpanded: true }}>
            <SearchContext.Provider
              value={{ searchResults: results([awmf], [hint('Kein Nystagmus.')]) }}
            >
              <Markdown
                content={
                  'Bis 4,5 h.\n\n::hinweise\n\nPflicht-Hinweis: ersetzt keine ärztliche Prüfung.'
                }
                isLatestMessage={false}
              />
            </SearchContext.Provider>
          </MessageContext.Provider>
        </RecoilRoot>
      </MemoryRouter>,
    );

    const panel = await screen.findByRole('region', { name: HEADING });
    const answer = screen.getByText('Bis 4,5 h.');
    const disclaimer = screen.getByText(/Pflicht-Hinweis/);
    expect(answer.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      panel.compareDocumentPosition(disclaimer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText('::hinweise')).not.toBeInTheDocument();
  });
});
