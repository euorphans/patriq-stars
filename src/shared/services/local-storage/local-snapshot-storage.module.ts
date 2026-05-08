import { Global, Module } from '@nestjs/common';
import { LocalSnapshotStorageService } from './local-snapshot-storage.service';

@Global()
@Module({
  providers: [LocalSnapshotStorageService],
  exports: [LocalSnapshotStorageService],
})
export class LocalSnapshotStorageModule {}
