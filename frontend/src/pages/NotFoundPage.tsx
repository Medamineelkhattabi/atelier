import { Link } from 'react-router-dom';
import { Page } from '../components/Page';
import { EmptyState } from '../components/ui';

export function NotFoundPage() {
  return (
    <Page title="Not found">
      <EmptyState
        title="This page does not exist"
        description="The link may be outdated."
        action={
          <Link to="/" className="text-sm font-medium text-accent-700 hover:underline dark:text-accent-300">
            Back to the dashboard
          </Link>
        }
      />
    </Page>
  );
}
