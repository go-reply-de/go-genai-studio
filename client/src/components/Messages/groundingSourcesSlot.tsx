import '~/components/Chat/Messages/Content/register';
import {
  getAppContentParts,
  setAppContentParts,
} from '~/components/Chat/Messages/Content/Parts/slots';
import GroundingSources from './GroundingSources';

/** Draws our source list under a message's content parts, inside the same row. */
const renderContentParts = getAppContentParts();

setAppContentParts((props) => (
  <>
    {renderContentParts(props)}
    <GroundingSources
      message={{ content: props.content }}
      searchResults={props.searchResults}
      isSubmitting={props.isSubmitting}
    />
  </>
));
