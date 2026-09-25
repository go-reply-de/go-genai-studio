import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ContentTypes } from 'librechat-data-provider';
import type { SearchResultData, TMessage } from 'librechat-data-provider';
import GroundingSources, { hasGroundingSources } from '~/components/Messages/GroundingSources';

/** Stands in for LibreChat's card panel: lists what it receives through the search context. */
jest.mock('~/components/Web/Sources', () => ({
  __esModule: true,
  default: function MockSources({ messageId }: { messageId?: string }) {
    const { useSearchContext } = jest.requireActual('~/Providers/SearchContext');
    const { searchResults } = useSearchContext();
    const titles = Object.values(searchResults ?? {}).flatMap(
      (result) => (result as SearchResultData).organic?.map((source) => source.title) ?? [],
    );
    return <div data-testid={`sources-${messageId}`}>{titles.join(', ')}</div>;
  },
}));

const toolCall = (name: string) => ({
  type: ContentTypes.TOOL_CALL,
  tool_call: { id: 'call_1', name, args: '{}', output: 'Quellen: …' },
});
const text = { type: ContentTypes.TEXT, text: 'Bis 4,5 h.' };
const searchResults: Record<string, SearchResultData> = {
  '0': {
    turn: 0,
    organic: [
      { position: 1, link: 'https://stub/awmf', title: 'awmf.org', attribution: '1 · awmf.org' },
      { position: 2, link: 'https://stub/dgn', title: 'dgn.org', attribution: '2 · dgn.org' },
    ],
  },
};

describe('hasGroundingSources', () => {
  it('shows the panel for an answer that searched with web_grounding_enterprise', () => {
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
  it("hands the answer's own sources to the card panel", () => {
    const message = {
      messageId: 'msg-1',
      conversationId: 'conv-1',
      content: [toolCall('web_grounding_enterprise'), text],
    } as unknown as TMessage;

    render(<GroundingSources message={message} searchResults={searchResults} />);

    expect(screen.getByTestId('sources-msg-1')).toHaveTextContent('awmf.org, dgn.org');
  });
});
