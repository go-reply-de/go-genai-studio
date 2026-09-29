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

  it('links the sources of hints saved before they were among the search results', () => {
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

  it('shows the sources of a hint as the same chips as the answer', () => {
    const blog = {
      position: 2,
      link: 'https://stub/blog',
      title: 'blog.example',
      attribution: 'blog.example',
      official: false,
    };
    const praxis = {
      position: 3,
      link: 'https://stub/praxis',
      title: 'praxis.example',
      attribution: 'praxis.example',
      official: false,
    };
    const searchResults = results(
      [awmf, blog, praxis],
      [
        hint('Ein Blog nennt 6 h.', null, [{ domain: 'blog.example', link: 'https://stub/blog' }]),
        hint('Zwei Seiten nennen 8 h.', null, [
          { domain: 'blog.example', link: 'https://stub/blog' },
          { domain: 'praxis.example', link: 'https://stub/praxis' },
        ]),
      ],
    );

    render(<GroundingHints searchResults={searchResults} />);
    openPanel();

    const single = screen.getByRole('link', { name: 'blog.example' });
    expect(single).toHaveAttribute('href', 'https://stub/blog');
    expect(single).toHaveClass('rounded-xl');
    expect(screen.getByRole('link', { name: 'blog.example +1' })).toBeInTheDocument();
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

describe('hints under their section', () => {
  const sectioned = (text: string, section: string, lead?: string) => ({
    ...hint(text),
    section,
    ...(lead ? { lead } : {}),
  });
  const answer = (messageId: string, content: string, hints: object[]) =>
    render(
      <MemoryRouter>
        <RecoilRoot>
          <MessageContext.Provider value={{ messageId, isExpanded: true }}>
            <SearchContext.Provider value={{ searchResults: results([awmf], hints) }}>
              <Markdown content={content} isLatestMessage={false} />
            </SearchContext.Provider>
          </MessageContext.Provider>
        </RecoilRoot>
      </MemoryRouter>,
    );
  const hints = [
    sectioned('Eine zu rasche Senkung ist zu vermeiden.', '0-1'),
    sectioned('Kalium über 5,5 mmol/l: keine Zugabe.', '0-2', 'Dosierungsschema'),
  ];

  it('shows the hints of a section as one line under it that opens to the points', async () => {
    answer(
      'section-open',
      [
        '- Rehydrierung:',
        '  - Initialtherapie mit einem Liter.',
        '',
        '  ::hinweise{abschnitt=0-1}',
        '- Kalium:',
        '  - Kalium früh ersetzen.',
        '',
        '  ::hinweise{abschnitt=0-2}',
        '',
        '::hinweise',
      ].join('\n'),
      hints,
    );

    const blocks = await screen.findAllByRole('button', { name: /ergänzender? Hinweis/ });
    expect(blocks.map((block) => block.textContent)).toEqual([
      '⚠ 1 ergänzender Hinweis – bitte eigenständig prüfen',
      '⚠ 1 ergänzender Hinweis – bitte eigenständig prüfen',
    ]);
    expect(screen.queryByText(/Eine zu rasche Senkung/)).not.toBeInTheDocument();

    fireEvent.click(blocks[1]);

    expect(screen.getByText(/Kalium über 5,5 mmol\/l: keine Zugabe\./)).toHaveTextContent(
      'Dosierungsschema: Kalium über 5,5 mmol/l: keine Zugabe.',
    );
    expect(blocks[1]).toHaveAccessibleDescription(/nicht durch AWMF/);
    expect(
      screen.getByText('Initialtherapie mit einem Liter.').compareDocumentPosition(blocks[0]) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: new RegExp(`${HEADING} \\(`) })).toBeNull();
  });

  it('gathers what the agent did not place in the closing panel', async () => {
    answer(
      'section-missing',
      [
        '- Rehydrierung:',
        '  - Initialtherapie.',
        '',
        '  ::hinweise{abschnitt=0-1}',
        '',
        '::hinweise',
      ].join('\n'),
      hints,
    );

    const closing = await screen.findByRole('button', { name: new RegExp(`${HEADING} \\(1\\)`) });
    fireEvent.click(closing);

    expect(screen.getByText(/Kalium über 5,5 mmol\/l/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /ergänzender? Hinweis/ })).toHaveLength(1);
  });

  it('leaves the markers out of a copied answer', () => {
    expect(
      stripGroundingMarkup(
        '- Kalium:\n  - Früh ersetzen.\n\n  ::hinweise{abschnitt=0-2}\n- Insulin:',
      ),
    ).toBe('- Kalium:\n  - Früh ersetzen.\n\n- Insulin:');
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

  it('copies anchors written as [turn0search0, …] like the anchors they stand for', () => {
    expect(
      stripGroundingMarkup('Bis 2 h. [turn0search0, turn0search1] Bis 6 h. [turn0search2]'),
    ).toBe(
      'Bis 2 h. \\ue200\\ue202turn0search0\\ue202turn0search1\\ue201 Bis 6 h. \\ue202turn0search2',
    );
  });

  it('shows anchors written as [turn0search0, …] as chips', async () => {
    const dgai = {
      position: 2,
      link: 'https://stub/dgai',
      title: 'dgai.de',
      attribution: 'dgai.de',
    };
    render(
      <MemoryRouter>
        <RecoilRoot>
          <MessageContext.Provider value={{ messageId: 'm1', isExpanded: true }}>
            <SearchContext.Provider value={{ searchResults: results([awmf, dgai], []) }}>
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
