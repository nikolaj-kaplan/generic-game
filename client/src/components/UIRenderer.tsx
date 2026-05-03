import { useEffect, useRef, useState } from 'react';
import { UIComponent } from '../types';
import { useGame } from '../context/GameContext';

interface UIRendererProps {
  components: UIComponent[];
}

/**
 * Top-level renderer. Maintains a shared input-values map so that standalone
 * `input` components and standalone `button` components can work together even
 * when the LLM doesn't wrap them in a `form`.
 */
export default function UIRenderer({ components }: UIRendererProps) {
  const { send } = useGame();
  // Shared state for standalone (top-level) inputs
  const [topInputValues, setTopInputValues] = useState<Record<string, string>>({});
  // Tracks which multiple_choice fieldIds have been submitted this screen
  const [submittedChoices, setSubmittedChoices] = useState<Record<string, string>>({});

  // Reset all interaction state whenever the UI changes (new screen from LLM)
  const prevComponents = useRef(components);
  useEffect(() => {
    if (prevComponents.current !== components) {
      setTopInputValues({});
      setSubmittedChoices({});
      prevComponents.current = components;
    }
  }, [components]);

  function handleTopInputChange(fieldId: string, value: string) {
    setTopInputValues((prev) => ({ ...prev, [fieldId]: value }));
  }

  function handleTopButtonClick(actionId: string) {
    if (Object.keys(topInputValues).length > 0) {
      // Treat as a form submission so the server carries the input values
      send({ type: 'form_submit', formId: actionId, values: topInputValues });
      setTopInputValues({});
    } else {
      send({ type: 'action', actionId });
    }
  }

  function handleChoiceSubmit(fieldId: string, option: string) {
    if (submittedChoices[fieldId]) return;
    setSubmittedChoices((prev) => ({ ...prev, [fieldId]: option }));
    send({ type: 'form_submit', formId: fieldId, values: { [fieldId]: option } });
  }

  return (
    <div className="ui-renderer">
      {components.map((comp, i) => (
        <UIComponentNode
          key={i}
          component={comp}
          topInputValues={topInputValues}
          onTopInputChange={handleTopInputChange}
          onTopButtonClick={handleTopButtonClick}
          submittedChoices={submittedChoices}
          onChoiceSubmit={handleChoiceSubmit}
        />
      ))}
    </div>
  );
}

interface NodeProps {
  component: UIComponent;
  topInputValues: Record<string, string>;
  onTopInputChange: (fieldId: string, value: string) => void;
  onTopButtonClick: (actionId: string) => void;
  submittedChoices: Record<string, string>;
  onChoiceSubmit: (fieldId: string, option: string) => void;
}

function UIComponentNode({ component: comp, topInputValues, onTopInputChange, onTopButtonClick, submittedChoices, onChoiceSubmit }: NodeProps) {
  switch (comp.type) {
    case 'text':
      return <TextComponent content={comp.content} style={comp.style} />;

    case 'input':
      // Standalone input — render it and tie into the shared top-level values map
      return (
        <label className="field">
          {comp.label && <span className="field__label">{comp.label}</span>}
          {comp.multiline ? (
            <textarea
              className="field__input"
              placeholder={comp.placeholder}
              maxLength={comp.maxLength}
              value={topInputValues[comp.fieldId] ?? ''}
              onChange={(e) => onTopInputChange(comp.fieldId, e.target.value)}
              rows={3}
              autoFocus
            />
          ) : (
            <input
              className="field__input"
              type="text"
              placeholder={comp.placeholder}
              maxLength={comp.maxLength}
              value={topInputValues[comp.fieldId] ?? ''}
              onChange={(e) => onTopInputChange(comp.fieldId, e.target.value)}
              autoFocus
            />
          )}
        </label>
      );

    case 'button':
      return (
        <button
          className={`btn btn--${comp.style ?? 'primary'} btn--full`}
          disabled={comp.disabled}
          onClick={() => onTopButtonClick(comp.actionId)}
        >
          {comp.label}
        </button>
      );

    case 'multiple_choice':
      return <MultipleChoice comp={comp} selected={submittedChoices[comp.fieldId] ?? null} onSelect={onChoiceSubmit} />;

    case 'countdown':
      return <Countdown comp={comp} />;

    case 'scoreboard':
      return <Scoreboard players={comp.players} />;

    case 'form':
      return <Form comp={comp} />;

    case 'list':
      return <ListComponent items={comp.items} ordered={comp.ordered} />;

    case 'divider':
      return <hr className="ui-divider" />;

    default:
      return null;
  }
}

// =============================================================================
// Text
// =============================================================================

function TextComponent({
  content,
  style,
}: {
  content: string;
  style?: UIComponent & { type: 'text' } extends { style?: infer S } ? S : never;
}) {
  const cls = style ? `ui-text ui-text--${style}` : 'ui-text';
  return (
    <p className={cls}>
      {content.split('\n').map((line, i, arr) => (
        <span key={i}>
          {line}
          {i < arr.length - 1 && <br />}
        </span>
      ))}
    </p>
  );
}

// =============================================================================
// Multiple Choice
// =============================================================================

function MultipleChoice({
  comp,
  selected,
  onSelect,
}: {
  comp: UIComponent & { type: 'multiple_choice' };
  selected: string | null;
  onSelect: (fieldId: string, option: string) => void;
}) {
  return (
    <div className="mc">
      <p className="mc__question">{comp.question}</p>
      <div className="mc__options">
        {comp.options.map((opt) => {
          let cls = 'mc__option';
          if (selected === opt) cls += ' mc__option--selected';
          else if (selected !== null) cls += ' mc__option--disabled';
          return (
            <button key={opt} className={cls} onClick={() => onSelect(comp.fieldId, opt)} disabled={selected !== null}>
              {opt}
            </button>
          );
        })}
      </div>
      {selected && <p className="mc__feedback text-muted">Answer submitted.</p>}
    </div>
  );
}

// =============================================================================
// Countdown
// =============================================================================

function Countdown({ comp }: { comp: UIComponent & { type: 'countdown' } }) {
  const { expiredTimers } = useGame();
  const [remaining, setRemaining] = useState(comp.seconds);
  const expired = expiredTimers.has(comp.timerId);

  useEffect(() => {
    if (expired || remaining <= 0) return;
    const id = setInterval(() => {
      setRemaining((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [expired, remaining]);

  const isUrgent = remaining <= 5 && !expired;

  return (
    <div className={`countdown ${isUrgent ? 'countdown--urgent' : ''} ${expired ? 'countdown--expired' : ''}`}>
      <span className="countdown__label">{comp.label ?? 'Time remaining'}</span>
      <span className="countdown__time">
        {expired ? '0' : remaining}s
      </span>
    </div>
  );
}

// =============================================================================
// Scoreboard
// =============================================================================

function Scoreboard({ players }: { players: Array<{ id: string; name: string; score: number }> }) {
  const sorted = [...players].sort((a, b) => b.score - a.score);

  return (
    <div className="scoreboard">
      <p className="scoreboard__title">Scores</p>
      {sorted.map((p, i) => (
        <div key={p.id} className="scoreboard__row">
          <span className="scoreboard__rank">{i + 1}.</span>
          <span className="scoreboard__name">{p.name}</span>
          <span className="scoreboard__score">{p.score}</span>
        </div>
      ))}
    </div>
  );
}

// =============================================================================
// Form
// =============================================================================

function Form({ comp }: { comp: UIComponent & { type: 'form' } }) {
  const { send } = useGame();
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  function handleChange(fieldId: string, value: string) {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitted) return;
    setSubmitted(true);
    send({ type: 'form_submit', formId: comp.formId, values });
  }

  return (
    <form className="ui-form" onSubmit={handleSubmit}>
      {comp.fields.map((field, i) => (
        <FormField
          key={i}
          field={field}
          value={values[(field as { fieldId?: string }).fieldId ?? ''] ?? ''}
          onChange={handleChange}
          disabled={submitted}
        />
      ))}
      <button
        className="btn btn--primary btn--full"
        type="submit"
        disabled={submitted}
      >
        {comp.submitLabel ?? 'Submit'}
      </button>
      {submitted && <p className="text-muted text-center">Submitted.</p>}
    </form>
  );
}

function FormField({
  field,
  value,
  onChange,
  disabled,
}: {
  field: UIComponent;
  value: string;
  onChange: (id: string, val: string) => void;
  disabled: boolean;
}) {
  if (field.type === 'input') {
    return (
      <label className="field">
        {field.label && <span className="field__label">{field.label}</span>}
        {field.multiline ? (
          <textarea
            className="field__input"
            placeholder={field.placeholder}
            maxLength={field.maxLength}
            value={value}
            onChange={(e) => onChange(field.fieldId, e.target.value)}
            disabled={disabled}
            rows={3}
          />
        ) : (
          <input
            className="field__input"
            type="text"
            placeholder={field.placeholder}
            maxLength={field.maxLength}
            value={value}
            onChange={(e) => onChange(field.fieldId, e.target.value)}
            disabled={disabled}
          />
        )}
      </label>
    );
  }

  if (field.type === 'text') {
    return <TextComponent content={field.content} style={field.style} />;
  }

  return null;
}

// =============================================================================
// List
// =============================================================================

function ListComponent({ items, ordered }: { items: string[]; ordered?: boolean }) {
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag className="ui-list">
      {items.map((item, i) => (
        <li key={i} className="ui-list__item">{item}</li>
      ))}
    </Tag>
  );
}
