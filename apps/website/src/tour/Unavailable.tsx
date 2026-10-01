import { Button, Logo } from '@internal/ui';
import { Link } from 'react-router';

export interface UnavailableProps {
  embed?: boolean;
  /** Set for a transient failure (not a 404): offers a retry. */
  retry?: () => void;
}

/** "This tour isn't available": the 404 state for share links and embeds (design README:162). */
export function Unavailable({ embed = false, retry }: UnavailableProps) {
  return (
    <div className="tour-page tour-unavailable">
      <meta name="robots" content="noindex" />
      <title>Tour unavailable · panote</title>
      <div className="tour-unavailable__card" role="status">
        <i className="fa-solid fa-eye-slash tour-unavailable__icon" aria-hidden="true" />
        <h1 className="tour-unavailable__title">
          {retry ? "This tour couldn't be loaded" : "This tour isn't available"}
        </h1>
        <p className="tour-unavailable__body">
          {retry
            ? 'Check your connection and try again.'
            : 'The link may have changed, or the owner stopped sharing it.'}
        </p>
        {retry && (
          <Button size="sm" onClick={retry}>
            Try again
          </Button>
        )}
      </div>
      {embed ? (
        <a className="tour-unavailable__brand" href="/" target="_blank" rel="noopener">
          <Logo />
        </a>
      ) : (
        <Link className="tour-unavailable__brand" to="/">
          <Logo />
        </Link>
      )}
    </div>
  );
}
