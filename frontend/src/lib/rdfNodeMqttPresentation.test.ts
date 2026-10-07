import { describe, expect, it } from 'vitest';
import { formatTopicDetails } from './rdfNodeMqttPresentation';

describe('RDF Node MQTT topic presentation', () => {
  it('shows documented ACK proof fields and withholds unlisted proof values', () => {
    const details = formatTopicDetails('ack/config', {
      result: {
        revision: 8,
        proof: {
          center_frequency_hz: 'FRESH_DAQ_RF_CENTER',
          vfo0_frequency_hz: 'FRESH_DOA_FREQUENCY',
          challenge: 'single-use-challenge-42',
          password: 'hidden-password',
          unlisted: 'hidden',
        },
      },
    });

    expect(details).toEqual([[
      'result',
      'revision=8; proof=center_frequency_hz=FRESH_DAQ_RF_CENTER; vfo0_frequency_hz=FRESH_DOA_FREQUENCY',
    ]]);
    expect(JSON.stringify(details)).not.toContain('single-use-challenge-42');
    expect(JSON.stringify(details)).not.toContain('hidden-password');
  });
});
