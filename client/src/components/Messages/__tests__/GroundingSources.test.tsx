import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ContentTypes } from 'librechat-data-provider';
import type { SearchResultData, TMessage } from 'librechat-data-provider';
import GroundingSources, { hasGroundingSources } from '~/components/Messages/GroundingSources';

const toolCall = (name: string) => ({
  type: ContentTypes.TOOL_CALL,
  tool_call: { id: 'call_1', name, args: '{}', output: 'Quellen: …' },
});
const text = { type: ContentTypes.TEXT, text: 'Bis 4,5 h.' };
const awmf = { position: 1, link: 'https://stub/awmf', title: 'awmf.org', attribution: 'awmf.org' };
const dgn = { position: 2, link: 'https://stub/dgn', title: 'dgn.org', attribution: 'dgn.org' };
const searchResults: Record<string, SearchResultData> = { '0': { turn: 0, organic: [awmf, dgn] } };
const grounded = {
  messageId: 'msg-1',
  conversationId: 'conv-1',
  content: [toolCall('web_grounding_enterprise'), text],
} as unknown as TMessage;
const links = () =>
  screen.getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')]);

describe('hasGroundingSources', () => {
  it('shows the list for an answer that searched with web_grounding_enterprise', () => {
    const content = [toolCall('web_grounding_enterprise'), text] as TMessage['content'];

    expect(hasGroundingSources(content, searchResults)).toBe(true);
  });

  it('leaves answers that did not use the tool alone', () => {
    const content = [toolCall('web_search'), text] as TMessage['content'];

    expect(hasGroundingSources(content, searchResults)).toBe(false);
  });

  it('leaves parallel answers to the panel their own view already renders', () => {
    const content = [
      { ...toolCall('web_grounding_enterprise'), groupId: 1 },
      { ...text, groupId: 1 },
    ] as TMessage['content'];

    expect(hasGroundingSources(content, searchResults)).toBe(false);
  });

  it('shows nothing when the search returned no sources', () => {
    const content = [toolCall('web_grounding_enterprise'), text] as TMessage['content'];

    expect(hasGroundingSources(content, { '0': { turn: 0, organic: [] } })).toBe(false);
  });
});

describe('GroundingSources', () => {
  it('lists the sources of the answer by domain under its heading', () => {
    render(<GroundingSources message={grounded} searchResults={searchResults} />);

    expect(
      screen.getByRole('heading', { name: 'Quellen und weiterführende Literatur' }),
    ).toBeInTheDocument();
    expect(links()).toEqual([
      ['awmf.org', 'https://stub/awmf'],
      ['dgn.org', 'https://stub/dgn'],
    ]);
    expect(screen.getAllByRole('link')[0]).toHaveAttribute('target', '_blank');
  });

  it('lists a source that several searches returned only once', () => {
    const rki = { position: 2, link: 'https://stub/rki', title: 'rki.de', attribution: 'rki.de' };
    const twice = { ...searchResults, '1': { turn: 1, organic: [dgn, rki] } };

    render(<GroundingSources message={grounded} searchResults={twice} />);

    expect(links().map(([title]) => title)).toEqual(['awmf.org', 'dgn.org', 'rki.de']);
  });

  it('renders nothing under an answer that did not use the tool', () => {
    const other = { ...grounded, content: [toolCall('web_search'), text] } as unknown as TMessage;

    const { container } = render(
      <GroundingSources message={other} searchResults={searchResults} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
