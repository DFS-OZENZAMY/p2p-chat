package app.p2pchat

import android.content.Context
import androidx.room.*
import kotlinx.coroutines.flow.Flow

@Entity
data class Contact(@PrimaryKey val id: String, val username: String, val publicKey: String)

@Entity(indices = [Index("peerId")])
data class Msg(
    @PrimaryKey val id: String,
    val peerId: String,
    val text: String,
    val ts: Long,
    val outgoing: Boolean,
    val sent: Boolean,
)

@Dao
interface ChatDao {
    @Query("SELECT * FROM Contact ORDER BY username") fun contacts(): Flow<List<Contact>>
    @Query("SELECT * FROM Contact WHERE id = :id") suspend fun contact(id: String): Contact?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun upsert(c: Contact)

    @Query("SELECT * FROM Msg WHERE peerId = :peer ORDER BY ts") fun messages(peer: String): Flow<List<Msg>>
    @Insert(onConflict = OnConflictStrategy.IGNORE) suspend fun insert(m: Msg)
    @Query("SELECT * FROM Msg WHERE peerId = :peer AND outgoing = 1 AND sent = 0 ORDER BY ts")
    suspend fun pending(peer: String): List<Msg>
    @Query("UPDATE Msg SET sent = 1 WHERE id = :id") suspend fun markSent(id: String)
}

@Database(entities = [Contact::class, Msg::class], version = 1, exportSchema = false)
abstract class AppDb : RoomDatabase() {
    abstract fun dao(): ChatDao

    companion object {
        fun create(ctx: Context): AppDb = Room.databaseBuilder(ctx, AppDb::class.java, "chat.db").build()
    }
}
