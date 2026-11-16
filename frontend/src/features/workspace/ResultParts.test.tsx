import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { readReport } from '../../lib/plain';
import { FullReport } from './ResultParts';

describe('FullReport', () => {
  it('shows team member names and hides internal ids', () => {
    const output = {
      status: 'complete',
      summary: 'Notes written',
      result: 'done',
      issues: [],
      steps: [{ task_id: 'research', agent: 'research', task: 'Collect constraints', status: 'completed', run_id: 'abc123' }],
      validation: [{ what: 'notes', by: 'testing', outcome: 'passed' }],
    };
    render(<FullReport report={readReport(output)} raw={output} answerShown names={{ research: { name: 'Researcher' }, testing: { name: 'Tester' } }} />);
    expect(screen.getByText('Researcher')).toBeInTheDocument();
    expect(screen.getByText('Tester')).toBeInTheDocument();
    expect(screen.getByText('Collect constraints')).toBeInTheDocument();
    expect(screen.queryByText('Task id')).not.toBeInTheDocument();
    expect(screen.queryByText('Run id')).not.toBeInTheDocument();
    expect(screen.queryByText('abc123')).not.toBeInTheDocument();
  });
});
