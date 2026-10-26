import type { JSX } from 'react';
import { useI18n } from '../lib/i18n';
import { Page, PageHeader, PageNotice } from '../components/page';

/** The Receiver route in the LAN view: no frame, the radio is the groundstation's. */
export function ReceiverViewOnlyPage(): JSX.Element {
  const { t } = useI18n();
  return (
    <Page>
      <PageHeader title={t('route.receiver')} />
      <PageNotice tone="info" title={t('shell.viewOnly')}>{t('lanView.receiverOnGroundstation')}</PageNotice>
    </Page>
  );
}
